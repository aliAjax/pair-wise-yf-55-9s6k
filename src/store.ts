import { configureStore, createSlice, type Middleware, type PayloadAction } from '@reduxjs/toolkit';
import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react';

export type FieldType = 'text' | 'number' | 'select' | 'date';
export interface FormField { id: string; label: string; type: FieldType; required: boolean; options?: string[]; }
export interface LinkRule { id: string; fieldId: string; operator: 'equals' | 'notEmpty'; value: string; effect: 'show' | 'require'; targetId: string; }

/** 发布时编译出的不可变规则快照，迁移后台只读这份快照 */
export interface CompiledSnapshot {
  versionId: string;
  compiledAt: string;
  rules: LinkRule[];
  evalOrder: string[];
  hash: string;
}
export interface FormVersion {
  id: string; label: string; createdAt: string;
  fields: FormField[]; rules: LinkRule[];
  snapshot: CompiledSnapshot;
}
/** 本地草稿：记录编辑时所基于的发布基线，用于发布时的乐观并发检查 */
export interface Draft {
  baseVersionId: string;
  fields: FormField[];
  rules: LinkRule[];
  conflict: boolean;
}
export interface Snapshot { id: string; versionId: string; label: string; data: Record<string, string>; }
export interface AuditRecord {
  id: string; recordId: string; recordLabel: string;
  fromVersionId: string; toVersionId: string; at: string;
  mode: 'batch' | 'lazy';
  addedFields: string[];
  status: 'success' | 'failed';
  message?: string;
}
export interface MigrationJob {
  id: string; fromVersionId: string; toVersionId: string; snapshotHash: string;
  status: 'running' | 'failed' | 'done';
  pending: string[];
  done: string[];
  failed: { recordId: string; message: string }[];
  failInjected: boolean;
  startedAt: string; updatedAt: string;
}

interface SchemaState {
  versions: FormVersion[];
  activeVersionId: string;
  draft: Draft;
  snapshots: Snapshot[];
  jobs: MigrationJob[];
  audit: AuditRecord[];
  simulateFailure: boolean;
  publishError: string | null;
  inspectVersionId: string;
}
type RootShape = { schema: SchemaState };
type SharedState = Pick<SchemaState, 'versions' | 'activeVersionId' | 'snapshots' | 'jobs' | 'audit'>;

const STORAGE_KEY = 'yf55-schema-state';
const BATCH_SIZE = 25;

/** 深拷贝：对普通对象和 Immer draft 代理都安全（structuredClone 无法克隆代理） */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

function hashString(input: string): string {
  let hash = 5381;
  for (let index = 0; index < input.length; index += 1) hash = ((hash << 5) + hash + input.charCodeAt(index)) >>> 0;
  return hash.toString(16).padStart(8, '0');
}

/** 联动规则构成 fieldId -> targetId 的有向图，发布前必须无环 */
function findCycle(rules: LinkRule[]): string[] | null {
  const graph = new Map<string, string[]>();
  for (const rule of rules) {
    if (!graph.has(rule.fieldId)) graph.set(rule.fieldId, []);
    graph.get(rule.fieldId)!.push(rule.targetId);
  }
  const mark = new Map<string, 1 | 2>();
  const stack: string[] = [];
  let cycle: string[] | null = null;
  const visit = (node: string) => {
    if (cycle) return;
    mark.set(node, 1);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      const state = mark.get(next);
      if (state === 1) { cycle = [...stack.slice(stack.indexOf(next)), next]; return; }
      if (!state) visit(next);
      if (cycle) return;
    }
    stack.pop();
    mark.set(node, 2);
  };
  for (const node of graph.keys()) {
    if (!mark.get(node)) visit(node);
    if (cycle) break;
  }
  return cycle;
}

function topoOrder(rules: LinkRule[]): string[] {
  const graph = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const rule of rules) {
    if (!graph.has(rule.fieldId)) graph.set(rule.fieldId, []);
    graph.get(rule.fieldId)!.push(rule.targetId);
    if (!indegree.has(rule.fieldId)) indegree.set(rule.fieldId, 0);
    indegree.set(rule.targetId, (indegree.get(rule.targetId) ?? 0) + 1);
  }
  const queue = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([node]) => node);
  const order: string[] = [];
  while (queue.length) {
    const node = queue.shift()!;
    order.push(node);
    for (const next of graph.get(node) ?? []) {
      const degree = indegree.get(next)! - 1;
      indegree.set(next, degree);
      if (degree === 0) queue.push(next);
    }
  }
  return order;
}

/** 编译不可变规则快照；有循环依赖时拒绝产出 */
function compileSnapshot(versionId: string, fields: FormField[], rules: LinkRule[]): { snapshot?: CompiledSnapshot; cycle?: string[] } {
  const cycle = findCycle(rules);
  if (cycle) return { cycle };
  const hash = hashString(JSON.stringify({
    fields: fields.map((field) => [field.id, field.label, field.type, field.required]),
    rules
  }));
  return {
    snapshot: {
      versionId,
      compiledAt: new Date().toISOString(),
      rules: deepFreeze(clone(rules)),
      evalOrder: topoOrder(rules),
      hash
    }
  };
}

function defaultValueFor(field: FormField): string {
  if (field.type === 'number') return '0';
  if (field.type === 'select') return field.options?.[0] ?? '';
  return '待补充';
}

function makeDraft(version: FormVersion): Draft {
  return { baseVersionId: version.id, fields: clone(version.fields), rules: clone(version.rules), conflict: false };
}

function nextVersionId(versions: FormVersion[]): string {
  const max = versions.reduce((acc, version) => Math.max(acc, Number(version.id.replace(/\D/g, '')) || 0), 0);
  return `v${max + 1}`;
}

const v1Fields: FormField[] = [
  { id: 'name', label: '申请名称', type: 'text', required: true },
  { id: 'department', label: '申请部门', type: 'select', required: true, options: ['研发', '市场', '财务'] },
  { id: 'amount', label: '申请金额', type: 'number', required: true }
];
const v2Fields: FormField[] = [
  { id: 'department', label: '申请部门', type: 'select', required: true, options: ['研发', '市场', '财务'] },
  { id: 'name', label: '申请名称', type: 'text', required: true },
  { id: 'budgetCode', label: '预算科目', type: 'text', required: false },
  { id: 'amount', label: '申请金额', type: 'number', required: true },
  { id: 'invoiceDate', label: '预计开票日期', type: 'date', required: false }
];
const v2Rules: LinkRule[] = [
  { id: 'r1', fieldId: 'department', operator: 'equals', value: '财务', effect: 'require', targetId: 'budgetCode' },
  { id: 'r2', fieldId: 'amount', operator: 'notEmpty', value: '', effect: 'show', targetId: 'invoiceDate' }
];

const v1: FormVersion = {
  id: 'v1', label: '费用申请 v1', createdAt: '2026-08-12',
  fields: v1Fields, rules: [],
  snapshot: compileSnapshot('v1', v1Fields, []).snapshot!
};
const v2: FormVersion = {
  id: 'v2', label: '费用申请 v2', createdAt: '2026-09-28',
  fields: v2Fields, rules: v2Rules,
  snapshot: compileSnapshot('v2', v2Fields, v2Rules).snapshot!
};

const initial: SchemaState = {
  versions: [v1, v2],
  activeVersionId: 'v2',
  draft: makeDraft(v2),
  snapshots: [
    { id: 's1', versionId: 'v1', label: '八月培训预算', data: { name: '培训预算', department: '财务', amount: '12000' } },
    { id: 's2', versionId: 'v1', label: '市场活动费用', data: { name: '新品活动', department: '市场', amount: '58000' } }
  ],
  jobs: [],
  audit: [],
  simulateFailure: true,
  publishError: null,
  inspectVersionId: 'v2'
};

function sharedOf(state: SchemaState): SharedState {
  return { versions: state.versions, activeVersionId: state.activeVersionId, snapshots: state.snapshots, jobs: state.jobs, audit: state.audit };
}

function pushAudit(state: SchemaState, entry: Omit<AuditRecord, 'id' | 'at'>) {
  state.audit.unshift({ ...entry, id: `audit-${Date.now()}-${state.audit.length}`, at: new Date().toISOString() });
  if (state.audit.length > 80) state.audit.length = 80;
}

/** 按目标版本的编译快照迁移单条记录：只补缺失字段，不改写已有值 */
function migrateRecord(record: Snapshot, version: FormVersion): string[] {
  const added: string[] = [];
  for (const field of version.fields) {
    if (!(field.id in record.data)) {
      record.data[field.id] = defaultValueFor(field);
      added.push(field.id);
    }
  }
  record.versionId = version.id;
  return added;
}

/** 处理当前运行中的任务的一批记录；注入故障时中断并保留进度 */
function processBatch(state: SchemaState) {
  const job = state.jobs.find((item) => item.status === 'running');
  if (!job) return;
  const target = state.versions.find((item) => item.id === job.toVersionId);
  if (!target) { job.status = 'failed'; return; }
  let processed = 0;
  while (processed < BATCH_SIZE && job.pending.length > 0) {
    const recordId = job.pending[0];
    if (state.simulateFailure && !job.failInjected && job.done.length >= BATCH_SIZE) {
      // 模拟中途故障：记录留在 pending，进度保留，等待重试
      job.failInjected = true;
      job.status = 'failed';
      job.updatedAt = new Date().toISOString();
      job.failed.push({ recordId, message: '模拟故障：回写审计日志超时' });
      pushAudit(state, {
        recordId, recordLabel: state.snapshots.find((item) => item.id === recordId)?.label ?? recordId,
        fromVersionId: job.fromVersionId, toVersionId: job.toVersionId,
        mode: 'batch', addedFields: [], status: 'failed', message: '模拟故障：回写审计日志超时'
      });
      return;
    }
    job.pending.shift();
    const record = state.snapshots.find((item) => item.id === recordId);
    if (!record) continue;
    if (record.versionId === job.toVersionId) {
      job.done.push(recordId);
      continue;
    }
    const fromVersionId = record.versionId;
    const added = migrateRecord(record, target);
    job.done.push(recordId);
    pushAudit(state, { recordId, recordLabel: record.label, fromVersionId, toVersionId: job.toVersionId, mode: 'batch', addedFields: added, status: 'success' });
    processed += 1;
  }
  job.updatedAt = new Date().toISOString();
  if (job.pending.length === 0) job.status = 'done';
}

const slice = createSlice({
  name: 'schema',
  initialState: initial,
  reducers: {
    reorderFields(state, action: PayloadAction<{ activeId: string; overId: string }>) {
      const from = state.draft.fields.findIndex((item) => item.id === action.payload.activeId);
      const to = state.draft.fields.findIndex((item) => item.id === action.payload.overId);
      if (from < 0 || to < 0) return;
      const [moved] = state.draft.fields.splice(from, 1);
      state.draft.fields.splice(to, 0, moved);
    },
    addField(state) {
      state.draft.fields.push({ id: `field-${Date.now()}`, label: '新字段', type: 'text', required: false });
    },
    addRule(state, action: PayloadAction<Omit<LinkRule, 'id'>>) {
      state.draft.rules.push({ ...action.payload, id: `rule-${Date.now()}` });
    },
    removeRule(state, action: PayloadAction<string>) {
      state.draft.rules = state.draft.rules.filter((rule) => rule.id !== action.payload);
    },
    /**
     * 发布：先比对本地草稿基线与持久化的当前版本（模拟服务端），
     * 基线已变则保留草稿并标记冲突；再编译不可变快照并检查循环依赖。
     */
    publishVersion(state) {
      const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY);
      const persistedActive = raw ? (JSON.parse(raw) as SchemaState).activeVersionId : state.activeVersionId;
      if (persistedActive !== state.draft.baseVersionId) {
        state.draft.conflict = true;
        state.publishError = null;
        return;
      }
      const compiled = compileSnapshot('pending', state.draft.fields, state.draft.rules);
      if (compiled.cycle) {
        state.publishError = `检测到循环依赖：${compiled.cycle.join(' → ')}，发布已阻止。`;
        return;
      }
      const id = nextVersionId(state.versions);
      const version: FormVersion = {
        id,
        label: `费用申请 ${id}`,
        createdAt: new Date().toISOString().slice(0, 10),
        fields: clone(state.draft.fields),
        rules: clone(state.draft.rules),
        snapshot: { ...compiled.snapshot!, versionId: id }
      };
      state.versions.push(version);
      state.activeVersionId = id;
      state.inspectVersionId = id;
      state.draft = makeDraft(version);
      state.publishError = null;
    },
    /** 重新比对：承认新基线，保留草稿内容，解除冲突标记 */
    rebaseDraft(state) {
      state.draft.baseVersionId = state.activeVersionId;
      state.draft.conflict = false;
    },
    inspectVersion(state, action: PayloadAction<string>) { state.inspectVersionId = action.payload; },
    toggleSimulateFailure(state) { state.simulateFailure = !state.simulateFailure; },
    generateRecords(state, action: PayloadAction<number>) {
      const departments = ['研发', '市场', '财务'];
      const stamp = Date.now();
      for (let index = 0; index < action.payload; index += 1) {
        state.snapshots.push({
          id: `rec-${stamp}-${index}`,
          versionId: 'v1',
          label: `历史费用单 #${index + 1}`,
          data: { name: `历史费用单 #${index + 1}`, department: departments[index % departments.length], amount: String(1000 + index * 137) }
        });
      }
    },
    startMigration(state, action: PayloadAction<string>) {
      const fromVersionId = action.payload;
      const pending = state.snapshots.filter((item) => item.versionId === fromVersionId).map((item) => item.id);
      if (pending.length === 0) return;
      const target = state.versions.find((item) => item.id === state.activeVersionId);
      if (!target || target.id === fromVersionId) return;
      const now = new Date().toISOString();
      state.jobs = [{
        id: `job-${Date.now()}`,
        fromVersionId,
        toVersionId: target.id,
        snapshotHash: target.snapshot.hash,
        status: 'running',
        pending,
        done: [],
        failed: [],
        failInjected: false,
        startedAt: now,
        updatedAt: now
      }];
    },
    migrationTick(state) { processBatch(state); },
    migrationRunAll(state) {
      let guard = 0;
      while (state.jobs.some((item) => item.status === 'running') && guard < 10000) {
        processBatch(state);
        guard += 1;
      }
    },
    /** 重试：只把状态复位为 running，pending 里剩下的就是未完成部分 */
    retryMigration(state) {
      const job = state.jobs.find((item) => item.status === 'failed');
      if (!job) return;
      job.status = 'running';
      job.failed = [];
      job.updatedAt = new Date().toISOString();
    },
    /** 懒迁移：单条旧数据被读取时才按原版本迁移并回写审计 */
    migrateRecordOnRead(state, action: PayloadAction<string>) {
      const record = state.snapshots.find((item) => item.id === action.payload);
      const target = state.versions.find((item) => item.id === state.activeVersionId);
      if (!record || !target || record.versionId === target.id) return;
      const fromVersionId = record.versionId;
      const added = migrateRecord(record, target);
      pushAudit(state, { recordId: record.id, recordLabel: record.label, fromVersionId, toVersionId: target.id, mode: 'lazy', addedFields: added, status: 'success' });
    },
    /** 跨标签页同步：只合并共享切片，保留本地草稿；基线变化时标记冲突 */
    syncShared(state, action: PayloadAction<SharedState>) {
      const shared = action.payload;
      state.versions = shared.versions;
      state.activeVersionId = shared.activeVersionId;
      state.snapshots = shared.snapshots;
      state.jobs = shared.jobs;
      state.audit = shared.audit;
      if (state.draft.baseVersionId !== shared.activeVersionId) state.draft.conflict = true;
    },
    replaceState(_state, action: PayloadAction<SchemaState>) { return action.payload; }
  }
});

export const schemaApi = createApi({
  reducerPath: 'schemaApi', baseQuery: fakeBaseQuery(),
  endpoints: (builder) => ({
    schemaHistory: builder.query<FormVersion[], string>({
      queryFn: (versionId) => {
        const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY);
        const state = raw ? JSON.parse(raw) as SchemaState : initial;
        return { data: state.versions.filter((item) => item.id !== versionId).slice(-3) };
      }
    })
  })
});

export const { useSchemaHistoryQuery } = schemaApi;
export const {
  addField, addRule, generateRecords, inspectVersion, migrateRecordOnRead, migrationRunAll, migrationTick,
  publishVersion, rebaseDraft, removeRule, reorderFields, replaceState, retryMigration, startMigration,
  syncShared, toggleSimulateFailure
} = slice.actions;

/** 只有共享切片（版本/数据/任务/审计）变化才落盘；本地草稿编辑不覆盖其他标签页的状态 */
const persistMiddleware: Middleware = (storeApi) => (next) => (action) => {
  const before = storeApi.getState() as RootShape;
  const result = next(action);
  const after = storeApi.getState() as RootShape;
  const isSync = typeof action === 'object' && action !== null && 'type' in action && action.type === syncShared.type;
  const sharedChanged = before.schema.versions !== after.schema.versions
    || before.schema.activeVersionId !== after.schema.activeVersionId
    || before.schema.snapshots !== after.schema.snapshots
    || before.schema.jobs !== after.schema.jobs
    || before.schema.audit !== after.schema.audit;
  if (!isSync && sharedChanged && typeof localStorage !== 'undefined') {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(after.schema));
  }
  return result;
};

export const store = configureStore({
  reducer: { schema: slice.reducer, [schemaApi.reducerPath]: schemaApi.reducer },
  middleware: (getDefault) => getDefault().concat(persistMiddleware, schemaApi.middleware)
});

if (typeof window !== 'undefined') {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) store.dispatch(replaceState(JSON.parse(saved) as SchemaState));
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY || !event.newValue) return;
    const incoming = JSON.parse(event.newValue) as SchemaState;
    const current = (store.getState() as RootShape).schema;
    if (JSON.stringify(sharedOf(current)) !== JSON.stringify(sharedOf(incoming))) {
      store.dispatch(syncShared(sharedOf(incoming)));
    }
  });
}
export type RootState = RootShape;
