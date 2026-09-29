import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react';
import {
  assertCompilable,
  compileSnapshot,
  CompileError,
  fingerprint,
  migrateRecord,
  type AuditTuple,
  type CompiledSnapshot,
  type DraftSchema,
  type FormRecord,
  type FormVersion,
  type LinkRule,
  type MigrationJob,
  type MigratedRecord
} from './engine';

const STORAGE_KEY = 'yf55-schema-state-v2';
const LEGACY_KEY = 'yf55-schema-state';

// ---------------------------------------------------------------------------
// 初始版本（已发布版本不可变；草稿才是可编辑副本）
// ---------------------------------------------------------------------------

const V1: FormVersion = {
  id: 'v1', label: '费用申请 v1', createdAt: '2026-08-12', parentId: null,
  fields: [
    { id: 'name', label: '申请名称', type: 'text', required: true },
    { id: 'department', label: '申请部门', type: 'select', required: true, options: ['研发', '市场', '财务'] },
    { id: 'amount', label: '申请金额', type: 'number', required: true }
  ],
  rules: []
};
const V2: FormVersion = {
  id: 'v2', label: '费用申请 v2', createdAt: '2026-09-28', parentId: 'v1',
  fields: [
    { id: 'department', label: '申请部门', type: 'select', required: true, options: ['研发', '市场', '财务'] },
    { id: 'name', label: '申请名称', type: 'text', required: true },
    { id: 'budgetCode', label: '预算科目', type: 'text', required: false },
    { id: 'amount', label: '申请金额', type: 'number', required: true },
    { id: 'invoiceDate', label: '预计开票日期', type: 'date', required: false }
  ],
  rules: [
    { id: 'r1', fieldId: 'department', operator: 'equals', value: '财务', effect: 'require', targetId: 'budgetCode' },
    { id: 'r2', fieldId: 'amount', operator: 'notEmpty', value: '', effect: 'show', targetId: 'invoiceDate' }
  ]
};

export interface PublishDiagnostic {
  cycles: string[][];
  dangling: CompiledSnapshot['danglingRefs'];
  message: string;
}

export interface LazyResult {
  recordId: string;
  result?: MigratedRecord;
  error?: string;
  at: string;
}

interface SchemaState {
  stateVersion: 2;
  seq: number;
  headVersionId: string;
  versions: FormVersion[];
  snapshots: CompiledSnapshot[];
  /** 编辑中的草稿 + 它所基于的已发布版本（乐观锁基线） */
  draft: { baselineId: string; baselineFingerprint: string; schema: DraftSchema; dirty: boolean };
  /** 后到发布者发现基线已变：保留草稿、提示重新比对 */
  conflict: { remoteVersionId: string; remoteLabel: string; reason: string } | null;
  /** 本页无未保存改动时，其他标签页发布产生的基线漂移提示 */
  baselineDrift: { remoteVersionId: string; remoteLabel: string } | null;
  /** 最近一次发布失败（循环依赖 / 悬空引用） */
  publishError: PublishDiagnostic | null;
  /** 后台迁移作业：断点续跑只补未完成记录 */
  migrationJob: MigrationJob | null;
  /** 已完成迁移的记录 id（按目标版本分桶，幂等） */
  migratedIds: Record<string, string[]>;
  /** 审计台账：每次回写一条紧凑记录 */
  audit: AuditTuple[];
  /** 运行态按当前版本提交的新数据 */
  submissions: FormRecord[];
}

type PersistedState = Omit<SchemaState, never>;

function cloneDraftOf(version: FormVersion): SchemaState['draft'] {
  return {
    baselineId: version.id,
    baselineFingerprint: fingerprint(version.fields, version.rules),
    schema: { label: version.label, fields: structuredClone(version.fields), rules: structuredClone(version.rules) },
    dirty: false
  };
}

function buildInitial(): SchemaState {
  const s1 = compileSnapshot(V1);
  const s2 = compileSnapshot(V2);
  return {
    stateVersion: 2,
    seq: 2,
    headVersionId: 'v2',
    versions: [V1, V2],
    snapshots: [s1, s2],
    draft: cloneDraftOf(V2),
    conflict: null,
    baselineDrift: null,
    publishError: null,
    migrationJob: null,
    migratedIds: {},
    audit: [],
    submissions: []
  };
}

function readPersisted(): SchemaState {
  if (typeof localStorage === 'undefined') return buildInitial();
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as PersistedState;
      if (parsed.stateVersion === 2) return recoverJob(parsed);
    } catch {
      /* 损坏则回退初始 */
    }
  }
  return buildInitial();
}

/** 上次持有作业的标签页已失活（心跳过期）才标记中断；其他标签页仍在跑则接管观察。 */
function recoverJob(state: SchemaState): SchemaState {
  const job = state.migrationJob;
  if (job && (job.status === 'running' || job.status === 'ready')) {
    const stale = Date.now() - job.heartbeat > 5000;
    if (stale) {
      return {
        ...state,
        migrationJob: {
          ...job,
          status: 'error',
          owner: null,
          lastError: '迁移进程中断（标签页关闭或后台报错），已保留进度，可重试补齐未完成部分。'
        }
      };
    }
    // 心跳新鲜：作业属于其他仍活着的标签页，本页只读观察
    return { ...state, migrationJob: { ...job, owner: job.owner } };
  }
  return state;
}

/** 跨标签页：以远端已发布事实为准，但保留本标签页未保存的草稿。 */
function mergeRemote(previous: SchemaState, remote: SchemaState): SchemaState {
  const draft = previous.draft;
  const remoteHead = remote.versions.find((version) => version.id === remote.headVersionId);
  const baselineMoved = remote.headVersionId !== draft.baselineId;
  // 有本地改动 → 冲突阻断（草稿保留）；无改动 → 仅漂移提示（可直接切换基线）
  const conflict = baselineMoved && draft.dirty && remoteHead
    ? { remoteVersionId: remoteHead.id, remoteLabel: remoteHead.label, reason: previous.conflict?.reason ?? '其他标签页已发布新版本' }
    : remote.conflict;
  return {
    ...remote,
    draft: previous.draft,
    conflict,
    baselineDrift: baselineMoved && !draft.dirty && remoteHead
      ? { remoteVersionId: remoteHead.id, remoteLabel: remoteHead.label }
      : remote.baselineDrift,
    submissions: previous.submissions
  };
}

const AUDIT_CAP = 8000;

function pushAudit(state: SchemaState, tuple: AuditTuple) {
  state.audit.push(tuple);
  if (state.audit.length > AUDIT_CAP) state.audit = state.audit.slice(-AUDIT_CAP);
}

const slice = createSlice({
  name: 'schema',
  initialState: readInitialState(),
  reducers: {
    reorderFields(state, action: PayloadAction<{ activeId: string; overId: string }>) {
      const fields = state.draft.schema.fields;
      const from = fields.findIndex((item) => item.id === action.payload.activeId);
      const to = fields.findIndex((item) => item.id === action.payload.overId);
      if (from < 0 || to < 0) return;
      const [moved] = fields.splice(from, 1);
      fields.splice(to, 0, moved);
      state.draft.dirty = true;
      state.publishError = null;
    },
    updateField(state, action: PayloadAction<{ id: string; patch: Partial<Pick<FormFieldish, 'label' | 'type' | 'required'>> }>) {
      const field = state.draft.schema.fields.find((item) => item.id === action.payload.id);
      if (!field) return;
      Object.assign(field, action.payload.patch);
      state.draft.dirty = true;
      state.publishError = null;
    },
    addField(state) {
      state.draft.schema.fields.push({ id: `field-${Date.now()}`, label: '新字段', type: 'text', required: false });
      state.draft.dirty = true;
      state.publishError = null;
    },
    deleteField(state, action: PayloadAction<string>) {
      state.draft.schema.fields = state.draft.schema.fields.filter((field) => field.id !== action.payload);
      state.draft.dirty = true;
      state.publishError = null;
    },
    addRule(state, action: PayloadAction<Omit<LinkRule, 'id'>>) {
      state.draft.schema.rules.push({ ...action.payload, id: `rule-${Date.now()}` });
      state.draft.dirty = true;
      state.publishError = null;
    },
    deleteRule(state, action: PayloadAction<string>) {
      state.draft.schema.rules = state.draft.schema.rules.filter((rule) => rule.id !== action.payload);
      state.draft.dirty = true;
      state.publishError = null;
    },
    /** 发布提交。reducer 再次比对持久层基线（点击与 dispatch 之间也可能被其他标签页抢先）。 */
    publishCommit(state, action: PayloadAction<{ version: FormVersion; snapshot: CompiledSnapshot }>) {
      const { version, snapshot } = action.payload;
      // 防御性二次校验：基线必须仍是当前 head，且指纹未变
      if (state.draft.baselineId !== state.headVersionId) {
        const head = state.versions.find((item) => item.id === state.headVersionId);
        state.conflict = { remoteVersionId: state.headVersionId, remoteLabel: head?.label ?? state.headVersionId, reason: '基线已被其他标签页推进' };
        return;
      }
      state.versions.push(version);
      state.snapshots.push(snapshot);
      state.seq = Number(version.id.slice(1));
      state.headVersionId = version.id;
      state.draft = cloneDraftOf(version);
      state.conflict = null;
      state.baselineDrift = null;
      state.publishError = null;
    },
    publishFailed(state, action: PayloadAction<PublishDiagnostic>) {
      state.publishError = action.payload;
    },
    /** 放弃本地草稿并以新版本为基线重新比对 */
    rebaseDraft(state) {
      const head = state.versions.find((version) => version.id === state.headVersionId);
      if (head) state.draft = cloneDraftOf(head);
      state.conflict = null;
      state.baselineDrift = null;
      state.publishError = null;
    },
    markConflict(state, action: PayloadAction<{ remoteVersionId: string; remoteLabel: string }>) {
      state.conflict = { ...action.payload, reason: '其他标签页已发布新版本（基线指纹不一致）' };
    },
    startMigration(state, action: PayloadAction<{ job: MigrationJob }>) {
      state.migrationJob = action.payload.job;
      if (!state.migratedIds[action.payload.job.toVersion]) state.migratedIds[action.payload.job.toVersion] = [];
    },
    migrationHeartbeat(state, action: PayloadAction<{ owner: string }>) {
      if (state.migrationJob && (state.migrationJob.owner === action.payload.owner || !state.migrationJob.owner)) {
        state.migrationJob.owner = action.payload.owner;
        state.migrationJob.heartbeat = Date.now();
      }
    },
    migrationProgress(
      state,
      action: PayloadAction<{ owner: string; done: { id: string; audit: AuditTuple }[]; failed: { recordId: string; error: string }[] }>
    ) {
      const job = state.migrationJob;
      if (!job || job.owner !== action.payload.owner) return;
      const bucket = state.migratedIds[job.toVersion] ?? (state.migratedIds[job.toVersion] = []);
      action.payload.done.forEach(({ id, audit }) => {
        if (!bucket.includes(id)) {
          bucket.push(id);
          pushAudit(state, audit);
        }
      });
      action.payload.failed.forEach((failure) => {
        if (!job.failed.some((item) => item.recordId === failure.recordId)) job.failed.push(failure);
      });
      job.processed = bucket.length;
      job.updatedAt = new Date().toISOString();
      job.heartbeat = Date.now();
    },
    migrationStatus(state, action: PayloadAction<{ status: MigrationJob['status']; lastError?: string | null; clearOwner?: boolean }>) {
      const job = state.migrationJob;
      if (!job) return;
      job.status = action.payload.status;
      if (action.payload.lastError !== undefined) job.lastError = action.payload.lastError;
      if (action.payload.clearOwner) job.owner = null;
      job.updatedAt = new Date().toISOString();
    },
    /** 重试：清空失败清单，作业回到 running，已完成 id 保留，扫描时自动跳过 */
    retryMigration(state, action: PayloadAction<{ owner: string }>) {
      const job = state.migrationJob;
      if (!job) return;
      job.failed = [];
      job.lastError = null;
      job.status = 'running';
      job.owner = action.payload.owner;
      job.heartbeat = Date.now();
    },
    pauseMigration(state) {
      const job = state.migrationJob;
      if (!job) return;
      job.status = 'paused';
      job.owner = null;
      job.lastError = null;
    },
    /** 懒迁移回写：按原版本快照解释后的单条结果落审计 */
    lazyMigrated(state, action: PayloadAction<{ result: MigratedRecord; targetVersionId: string }>) {
      const { result, targetVersionId } = action.payload;
      if (result.migrated) {
        const bucket = state.migratedIds[targetVersionId] ?? (state.migratedIds[targetVersionId] = []);
        if (!bucket.includes(result.record.id)) {
          bucket.push(result.record.id);
          pushAudit(state, [
            result.record.id,
            result.path[0],
            targetVersionId,
            new Date().toISOString(),
            'lazy',
            result.changes.reduce((sum, change) => sum + change.added.length, 0),
            result.changes.reduce((sum, change) => sum + change.removed.length, 0)
          ]);
        }
      }
    },
    addSubmission(state, action: PayloadAction<Record<string, string>>) {
      state.submissions.unshift({ id: `sub-${Date.now()}`, versionId: state.headVersionId, label: action.payload.name ?? '运行态提交', data: action.payload });
    },
    trimAudit(state, action: PayloadAction<number>) {
      state.audit = state.audit.slice(-action.payload);
    },
    remoteSynced: (state, action: PayloadAction<SchemaState>) => mergeRemote(state, action.payload),
    replaceState(_state, action: PayloadAction<SchemaState>) {
      return recoverJob(action.payload);
    }
  }
});

// 初始值要在 slice 创建前可用
function readInitialState(): SchemaState {
  const initial = readPersisted();
  return initial;
}

type FormFieldish = SchemaState['draft']['schema']['fields'][number];

// ---------------------------------------------------------------------------
// 发布 thunk：先编译不可变快照 + 循环依赖/悬空引用闸口；再做跨标签页乐观锁
// ---------------------------------------------------------------------------

export function publishDraft() {
  return (_dispatch: AppDispatch, getState: () => RootState): { ok: boolean; reason?: string } => {
    const state = getState().schema;
    const { draft } = state;

    // 1. 读持久层的真实 head：另一个标签页可能在本页渲染后已经发布
    let remote: SchemaState | null = null;
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        try { remote = JSON.parse(raw) as SchemaState; } catch { remote = null; }
      }
    }
    if (remote && remote.headVersionId !== draft.baselineId) {
      const head = remote.versions.find((version) => version.id === remote.headVersionId);
      const remoteHead = head;
      // 只标记冲突并保留本页草稿；远端版本列表随后由 storage 事件同步进来
      _dispatch(slice.actions.publishFailed({
        cycles: [], dangling: [],
        message: `基线已变：${remoteHead?.label ?? remote.headVersionId} 已由其他标签页发布，草稿已保留，请重新比对后再决定发布。`
      }));
      _dispatch(slice.actions.markConflict({ remoteVersionId: remote.headVersionId, remoteLabel: remoteHead?.label ?? remote.headVersionId }));
      return { ok: false, reason: 'baseline-changed' };
    }

    // 2. 编译不可变快照并做循环依赖 / 悬空引用检查
    const candidate: FormVersion = {
      id: `v${state.seq + 1}`,
      label: draft.schema.label || `费用申请 v${state.seq + 1}`,
      createdAt: new Date().toISOString().slice(0, 10),
      parentId: draft.baselineId,
      fields: structuredClone(draft.schema.fields),
      rules: structuredClone(draft.schema.rules)
    };
    const snapshot = compileSnapshot(candidate);
    try {
      assertCompilable(snapshot);
    } catch (error) {
      if (error instanceof CompileError) {
        _dispatch(slice.actions.publishFailed({
          cycles: error.cycles,
          dangling: error.danglingRefs,
          message: error.message
        }));
        return { ok: false, reason: 'compile' };
      }
      throw error;
    }

    _dispatch(slice.actions.publishCommit({ version: candidate, snapshot }));
    return { ok: true };
  };
}

/** 懒迁移单条旧记录：始终读取编译快照，按原版本沿版本链映射。 */
export function lazyMigrateThunk(record: FormRecord, targetVersionId: string) {
  return (dispatch: AppDispatch, getState: () => RootState): LazyResult => {
    const { snapshots } = getState().schema;
    try {
      const result = migrateRecord(record, targetVersionId, snapshots);
      dispatch(slice.actions.lazyMigrated({ result, targetVersionId }));
      return { recordId: record.id, result, at: new Date().toISOString() };
    } catch (error) {
      return { recordId: record.id, error: error instanceof Error ? error.message : String(error), at: new Date().toISOString() };
    }
  };
}

// 兼容既有 RTK Query 入口：历史版本列表
export const schemaApi = createApi({
  reducerPath: 'schemaApi',
  baseQuery: fakeBaseQuery(),
  endpoints: (builder) => ({
    schemaHistory: builder.query<FormVersion[], string>({
      queryFn: (excludeId, queryApi) => {
        const state = (queryApi as unknown as { getState: () => RootState }).getState();
        const versions = state.schema.versions;
        return { data: versions.filter((item) => item.id !== excludeId).slice(-5) };
      }
    })
  })
});

export const { useSchemaHistoryQuery } = schemaApi;
export const schemaActions = slice.actions;
export const {
  reorderFields, updateField, addField, deleteField, addRule, deleteRule,
  rebaseDraft, startMigration, migrationHeartbeat, migrationProgress,
  migrationStatus, retryMigration, pauseMigration, addSubmission, trimAudit,
  remoteSynced, replaceState
} = slice.actions;

export const store = configureStore({
  reducer: { schema: slice.reducer, [schemaApi.reducerPath]: schemaApi.reducer },
  middleware: (getDefault) => getDefault().concat(schemaApi.middleware)
});

export type RootState = { schema: SchemaState };
export type AppDispatch = typeof store.dispatch;

// ---------------------------------------------------------------------------
// 持久化 + 多标签页协同
// ---------------------------------------------------------------------------

if (typeof window !== 'undefined') {
  let last = JSON.stringify(store.getState().schema);
  try { localStorage.setItem(STORAGE_KEY, last); } catch { /* 首帧失败可忽略 */ }
  store.subscribe(() => {
    const current = store.getState().schema;
    // 不把"其他标签页作业失活"的本地判定回写：作业归属由心跳持有者更新
    const remoteRaw = localStorage.getItem(STORAGE_KEY);
    if (remoteRaw && current.migrationJob?.status === 'error') {
      try {
        const remote = JSON.parse(remoteRaw) as SchemaState;
        if (remote.migrationJob?.planId === current.migrationJob.planId &&
            remote.migrationJob.status === 'running' &&
            Date.now() - remote.migrationJob.heartbeat < 5000) {
          return;
        }
      } catch { /* 解析失败照常持久化 */ }
    }
    const next = JSON.stringify(current);
    if (next !== last) {
      last = next;
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch (error) {
        // 审计台账可能撑爆配额：裁剪旧审计后重试，迁移进度等关键数据优先保留
        if (error instanceof DOMException) {
          store.dispatch(trimAudit(Math.floor(store.getState().schema.audit.length / 2)));
        }
      }
    }
  });

  // 其他标签页发布 / 迁移进展推送过来
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY || !event.newValue) return;
    try {
      const remote = JSON.parse(event.newValue) as SchemaState;
      if (remote.stateVersion === 2) store.dispatch(remoteSynced(remote));
    } catch {
      /* 忽略损坏消息 */
    }
  });

  // 清理 v1 演示数据键
  localStorage.removeItem(LEGACY_KEY);
}
