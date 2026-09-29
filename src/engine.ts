// 规则编译 / 循环依赖检查 / 版本链懒迁移引擎。
// 发布时产出的 CompiledSnapshot 一旦写入版本即不可变；迁移与回放只读取快照，
// 不读取当前草稿，因此旧数据永远按"提交时的版本"解释。

export type FieldType = 'text' | 'number' | 'select' | 'date';

export interface FormField {
  id: string;
  label: string;
  type: FieldType;
  required: boolean;
  options?: string[];
}

export interface LinkRule {
  id: string;
  fieldId: string; // 触发字段
  operator: 'equals' | 'notEmpty';
  value: string;
  effect: 'show' | 'require';
  targetId: string; // 被影响字段
}

export interface FormVersion {
  id: string;
  label: string;
  createdAt: string;
  parentId: string | null; // 发布基线，构成版本链
  fields: FormField[];
  rules: LinkRule[];
}

/** 发布时编译的不可变快照：规则解释结果冻结在此，字段/规则后续再改不影响它。 */
export interface CompiledSnapshot {
  versionId: string;
  parentId: string | null;
  compiledAt: string;
  /** 结构指纹，乐观锁比对基线是否已变时使用 */
  fingerprint: string;
  fields: FormField[];
  rules: LinkRule[];
  /** fieldId -> 依赖它取值的规则；联动求值时沿边传播 */
  edges: { from: string; ruleId: string; to: string }[];
  /** 编译时发现的悬空引用（引用了已删除字段） */
  danglingRefs: { ruleId: string; fieldId: string; kind: 'source' | 'target' }[];
}

export interface DraftSchema {
  label: string;
  fields: FormField[];
  rules: LinkRule[];
}

export interface RecordData {
  [fieldId: string]: string;
}

export interface FormRecord {
  id: string;
  versionId: string; // 提交时版本；旧记录的解释锚点
  label: string;
  data: RecordData;
}

export interface MigrationStep {
  from: string;
  to: string;
}

export interface StepChange {
  step: MigrationStep;
  added: string[];
  removed: string[];
  coerced: string[];
}

export interface MigratedRecord {
  record: FormRecord;
  migrated: boolean;
  /** 经过的版本链，例如 v1 -> v2 -> v3 */
  path: string[];
  /** 每一步字段的增删，用于审计与差异展示 */
  changes: StepChange[];
}

/** 一条迁移审计：紧凑元组，压缩落盘体积（几万条也能持久化） */
export type AuditTuple = [
  recordId: string,
  fromVersion: string,
  toVersion: string,
  at: string,
  mode: 'lazy' | 'batch',
  addedCount: number,
  removedCount: number
];

export type MigrationPlanStatus = 'ready' | 'running' | 'paused' | 'error' | 'done';

export interface MigrationJob {
  planId: string;
  fromVersion: string;
  toVersion: string;
  status: MigrationPlanStatus;
  total: number;
  processed: number;
  /** 已完成记录 id（去重；重试只补未完成部分） */
  doneIds: string[];
  failed: { recordId: string; error: string }[];
  lastError: string | null;
  startedAt: string;
  updatedAt: string;
  /** 多标签页互斥：持有者心跳 */
  owner: string | null;
  heartbeat: number;
}

/** 轻量指纹：字段 id/类型/必填 + 规则 id/形态，供发布乐观锁使用 */
export function fingerprint(fields: FormField[], rules: LinkRule[]): string {
  const f = fields.map((x) => `${x.id}:${x.type}:${x.required ? 1 : 0}`).sort().join('|');
  const r = rules
    .map((x) => `${x.id}:${x.fieldId}:${x.operator}:${x.value}:${x.effect}:${x.targetId}`)
    .sort()
    .join('|');
  return shortHash(`${f}#${r}`);
}

function shortHash(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i += 1) h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export class CompileError extends Error {
  cycles: string[][];
  danglingRefs: CompiledSnapshot['danglingRefs'];
  constructor(message: string, cycles: string[][], danglingRefs: CompiledSnapshot['danglingRefs']) {
    super(message);
    this.name = 'CompileError';
    this.cycles = cycles;
    this.danglingRefs = danglingRefs;
  }
}

/** 编译快照：解析联动边、检查悬空引用，并对 field -> rule -> field 依赖图做环检测。 */
export function compileSnapshot(version: { id: string; parentId: string | null; fields: FormField[]; rules: LinkRule[] }): CompiledSnapshot {
  const ids = new Set(version.fields.map((field) => field.id));
  const edges: CompiledSnapshot['edges'] = [];
  const danglingRefs: CompiledSnapshot['danglingRefs'] = [];

  version.rules.forEach((rule) => {
    if (!ids.has(rule.fieldId)) danglingRefs.push({ ruleId: rule.id, fieldId: rule.fieldId, kind: 'source' });
    if (!ids.has(rule.targetId)) danglingRefs.push({ ruleId: rule.id, fieldId: rule.targetId, kind: 'target' });
    if (ids.has(rule.fieldId) && ids.has(rule.targetId)) {
      edges.push({ from: rule.fieldId, ruleId: rule.id, to: rule.targetId });
    }
  });

  const cycles = detectCycles(version.fields.map((field) => field.id), edges);

  return {
    versionId: version.id,
    parentId: version.parentId,
    compiledAt: new Date().toISOString(),
    fingerprint: fingerprint(version.fields, version.rules),
    fields: structuredClone(version.fields),
    rules: structuredClone(version.rules),
    edges,
    danglingRefs
  };
}

/** 发布闸口：快照必须无悬空引用、无循环依赖才允许发布。 */
export function assertCompilable(snapshot: CompiledSnapshot): void {
  const cycles = detectCycles(snapshot.fields.map((field) => field.id), snapshot.edges);
  if (cycles.length > 0 || snapshot.danglingRefs.length > 0) {
    throw new CompileError(
      cycles.length > 0 ? `检测到 ${cycles.length} 组循环联动依赖` : '存在引用已删除字段的失效规则',
      cycles,
      snapshot.danglingRefs
    );
  }
}

/** DFS 找环，返回每条环上的字段 id 序列。 */
export function detectCycles(nodes: string[], edges: { from: string; to: string }[]): string[][] {
  const adj = new Map<string, string[]>();
  nodes.forEach((id) => adj.set(id, []));
  edges.forEach((edge) => adj.get(edge.from)?.push(edge.to));

  const state = new Map<string, 0 | 1 | 2>(); // 0 未访问 1 在栈中 2 已完成
  const stack: string[] = [];
  const cycles: string[][] = [];
  const seen = new Set<string>();

  const visit = (node: string) => {
    state.set(node, 1);
    stack.push(node);
    for (const next of adj.get(node) ?? []) {
      if (state.get(next) === 1) {
        const cycle = stack.slice(stack.indexOf(next)).concat(next);
        const key = [...cycle].sort().join('>');
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push(cycle);
        }
      } else if (state.get(next) !== 2) {
        visit(next);
      }
    }
    stack.pop();
    state.set(node, 2);
  };

  nodes.forEach((node) => {
    if (!state.has(node)) visit(node);
  });
  return cycles;
}

/** 单步字段映射：新增字段留空、删除字段丢弃、类型变化做字符串安全转换。 */
export function applyStep(data: RecordData, from: CompiledSnapshot, to: CompiledSnapshot): { change: StepChange; data: RecordData } {
  const fromTypes = new Map(from.fields.map((field) => [field.id, field.type]));
  const next: RecordData = { ...data };
  const added: string[] = [];
  const removed: string[] = [];
  const coerced: string[] = [];

  to.fields.forEach((field) => {
    if (!(field.id in next)) {
      next[field.id] = '';
      added.push(field.id);
    } else if (fromTypes.get(field.id) && fromTypes.get(field.id) !== field.type) {
      if (field.type === 'number' && Number.isNaN(Number(next[field.id]))) next[field.id] = '';
      coerced.push(field.id);
    }
  });
  from.fields.forEach((field) => {
    if (!to.fields.some((target) => target.id === field.id)) {
      delete next[field.id];
      removed.push(field.id);
    }
  });

  return { change: { step: { from: from.versionId, to: to.versionId }, added, removed, coerced }, data: next };
}

/** 按版本链懒迁移：读原始版本快照逐步映射，绝不按当前草稿解释。 */
export function migrateRecord(
  record: FormRecord,
  targetVersionId: string,
  snapshots: CompiledSnapshot[]
): MigratedRecord {
  if (record.versionId === targetVersionId) {
    return { record, migrated: false, path: [record.versionId], changes: [] };
  }
  const byVersion = new Map(snapshots.map((snapshot) => [snapshot.versionId, snapshot]));
  const start = byVersion.get(record.versionId);
  const target = byVersion.get(targetVersionId);
  if (!start || !target) throw new Error(`缺少版本快照：${!start ? record.versionId : targetVersionId}`);

  // 用快照父子关系还原链
  const chain: CompiledSnapshot[] = [];
  let cursor: CompiledSnapshot | undefined = target;
  while (cursor) {
    chain.unshift(cursor);
    if (cursor.versionId === record.versionId) break;
    cursor = cursor.parentId ? byVersion.get(cursor.parentId) : undefined;
  }
  if (chain[0]?.versionId !== record.versionId) throw new Error(`版本链不连续，无法从 ${record.versionId} 迁移到 ${targetVersionId}`);

  let data = structuredClone(record.data);
  const changes: StepChange[] = [];
  for (let i = 0; i < chain.length - 1; i += 1) {
    const result = applyStep(data, chain[i], chain[i + 1]);
    data = result.data;
    changes.push(result.change);
  }
  return {
    record: { ...record, data },
    migrated: true,
    path: chain.map((snapshot) => snapshot.versionId),
    changes
  };
}

// ---------------------------------------------------------------------------
// 旧记录数据集：几万条，确定性生成（内存中不一次性改写，落盘只存处理标记）
// ---------------------------------------------------------------------------

export const DATASET_SIZE = 30000;
const DEPARTMENTS = ['研发', '市场', '财务'];

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 按下标确定性取一条记录；不需要时不实例化整个数组。 */
export function getRecordAt(index: number, versionOrder?: Map<string, number>): FormRecord {
  if (index < 0 || index >= DATASET_SIZE) throw new Error('记录下标越界');
  const rand = mulberry32(index + 1);
  // 前 60% 是 v1 老数据，后 40% 是 v2 时代提交的数据
  const isV1 = index < DATASET_SIZE * 0.6;
  let versionId = isV1 ? 'v1' : 'v2';
  const data: RecordData = {
    name: `历史单据 ${String(index + 1).padStart(5, '0')}`,
    department: DEPARTMENTS[Math.floor(rand() * DEPARTMENTS.length)],
    amount: String(500 + Math.floor(rand() * 99500))
  };
  if (!isV1) {
    data.budgetCode = rand() > 0.4 ? `BX-${1000 + Math.floor(rand() * 900)}` : '';
    data.invoiceDate = rand() > 0.5 ? `2026-0${1 + Math.floor(rand() * 9)}-1${Math.floor(rand() * 9)}` : '';
  }
  // 数据集只生成到 v2；目标版本更新时记录仍锚定它提交时的版本（v1/v2 快照均保留）
  if (versionOrder && !versionOrder.has(versionId)) versionId = 'v1';
  return { id: `rec-${String(index + 1).padStart(6, '0')}`, versionId, label: data.name, data };
}

/** 判断记录是否属于目标版本之前的旧数据（目标版本本身及更新的记录不迁移）。 */
export function isOlderVersion(recordVersion: string, targetVersion: string, versionOrder: Map<string, number>): boolean {
  const from = versionOrder.get(recordVersion);
  const to = versionOrder.get(targetVersion);
  if (from === undefined || to === undefined) return false;
  return from < to;
}

export function findRecord(id: string): FormRecord | undefined {
  const match = /^rec-(\d{6})$/.exec(id);
  if (!match) return undefined;
  const index = Number(match[1]) - 1;
  return index < DATASET_SIZE ? getRecordAt(index) : undefined;
}

export function recordVersionAt(index: number): string {
  return index < DATASET_SIZE * 0.6 ? 'v1' : 'v2';
}
