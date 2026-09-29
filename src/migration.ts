// 后台迁移执行器：
// - 分批扫描几万条记录，按记录原始版本沿不可变快照链迁移；
// - 每批回写进度 + 审计；中断/报错保留进度，重试只补未完成部分；
// - owner 心跳实现多标签页互斥。

import {
  DATASET_SIZE,
  getRecordAt,
  isOlderVersion,
  migrateRecord,
  recordVersionAt,
  type AuditTuple,
  type MigrationJob
} from './engine';
import {
  migrationHeartbeat,
  migrationProgress,
  migrationStatus,
  startMigration,
  type AppDispatch,
  type RootState
} from './store';

const BATCH_SIZE = 250;
const BATCH_DELAY_MS = 40;

let timer: ReturnType<typeof setTimeout> | null = null;
let runningOwner: string | null = null;
let cancelled = false;
/** 演示用：下次迁移会在处理到第 N 条后注入一次错误（断点保留） */
let failAfter: { count: number; message: string } | null = null;
let cursor = 0;

export function armFailure(count: number, message = '模拟后台报错：预算科目映射服务超时') {
  failAfter = { count, message };
}

export function isRunnerActive(): boolean {
  return timer !== null;
}

export interface StartOptions {
  fromVersion: string;
  targetVersion: string;
}

export function startJob(dispatch: AppDispatch, getState: () => RootState, options: StartOptions) {
  const state = getState().schema;
  // 仅迁移目标版本之前提交的旧记录
  const total = countMigratable(options.targetVersion, state.versions);
  const owner = `tab-${Math.random().toString(36).slice(2, 10)}`;
  const now = new Date().toISOString();
  const job: MigrationJob = {
    planId: `plan-${options.fromVersion}-${options.targetVersion}-${Date.now()}`,
    fromVersion: options.fromVersion,
    toVersion: options.targetVersion,
    status: 'running',
    total,
    processed: state.migratedIds[options.targetVersion]?.length ?? 0,
    doneIds: [],
    failed: [],
    lastError: null,
    startedAt: now,
    updatedAt: now,
    owner,
    heartbeat: Date.now()
  };
  dispatch(startMigration({ job }));
  cursor = 0;
  runningOwner = owner;
  cancelled = false;
  schedule(dispatch, getState, owner);
}

export function resumeJob(dispatch: AppDispatch, getState: () => RootState, owner: string) {
  cursor = 0;
  runningOwner = owner;
  cancelled = false;
  schedule(dispatch, getState, owner);
}

/** 暂停时取消本标签页的调度循环，避免在状态提交前再多跑一批。 */
export function cancelRunner() {
  cancelled = true;
  if (timer) { clearTimeout(timer); timer = null; }
  runningOwner = null;
}

/** 计算需要迁移的记录数：版本早于目标版本的记录（目标版本本身的记录不迁移）。 */
function countMigratable(targetVersion: string, versions: RootState['schema']['versions']): number {
  const order = new Map<string, number>();
  versions.forEach((version, index) => order.set(version.id, index));
  let count = 0;
  for (let i = 0; i < DATASET_SIZE; i += 1) {
    if (isOlderVersion(recordVersionAt(i), targetVersion, order)) count += 1;
  }
  return count;
}

function schedule(dispatch: AppDispatch, getState: () => RootState, owner: string) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => tick(dispatch, getState, owner), BATCH_DELAY_MS);
}

function tick(dispatch: AppDispatch, getState: () => RootState, owner: string) {
  if (cancelled) { stop(owner); return; }
  const state = getState().schema;
  const job = state.migrationJob;
  if (!job || runningOwner !== owner) { stop(owner); return; }
  if (job.owner !== owner || job.status !== 'running') { stop(owner); return; }

  const { toVersion } = job;
  const done = new Set(state.migratedIds[toVersion] ?? []);
  const snapshots = state.snapshots;
  const versionOrder = new Map<string, number>();
  state.versions.forEach((version, index) => versionOrder.set(version.id, index));

  let scanned = 0;
  let injected = false;
  const batchDone: { id: string; audit: AuditTuple }[] = [];
  const batchFailed: { recordId: string; error: string }[] = [];

  while (cursor < DATASET_SIZE && scanned < BATCH_SIZE) {
    const index = cursor;
    cursor += 1;
    const versionId = recordVersionAt(index);
    if (!isOlderVersion(versionId, toVersion, versionOrder)) continue; // 非旧数据，跳过
    scanned += 1;
    const record = getRecordAt(index, versionOrder);
    if (done.has(record.id)) continue; // 重试时跳过已完成部分
    try {
      const result = migrateRecord(record, toVersion, snapshots);
      batchDone.push({
        id: record.id,
        audit: [
          record.id,
          record.versionId,
          toVersion,
          new Date().toISOString(),
          'batch',
          result.changes.reduce((sum, change) => sum + change.added.length, 0),
          result.changes.reduce((sum, change) => sum + change.removed.length, 0)
        ]
      });
      done.add(record.id);
    } catch (error) {
      batchFailed.push({ recordId: record.id, error: error instanceof Error ? error.message : String(error) });
    }
    if (failAfter && batchDone.length >= failAfter.count && !injected) {
      injected = true;
      const fault = failAfter;
      failAfter = null;
      dispatch(migrationProgress({ owner, done: batchDone, failed: batchFailed }));
      dispatch(migrationStatus({ status: 'error', lastError: `${fault.message}（已处理 ${done.size} 条，进度已保留）` }));
      stop(owner);
      return;
    }
  }

  if (batchDone.length || batchFailed.length) {
    dispatch(migrationProgress({ owner, done: batchDone, failed: batchFailed }));
  }
  dispatch(migrationHeartbeat({ owner }));

  const latest = getState().schema.migrationJob;
  if (cursor >= DATASET_SIZE) {
    const failedLeft = (getState().schema.migrationJob?.failed.length ?? 0) > 0;
    dispatch(migrationStatus({
      status: failedLeft ? 'error' : 'done',
      lastError: failedLeft ? latest?.lastError ?? `${latest?.failed.length} 条记录迁移失败，可重试补齐` : null,
      clearOwner: true
    }));
    stop(owner);
    return;
  }
  schedule(dispatch, getState, owner);
}

function stop(owner: string) {
  if (runningOwner === owner) runningOwner = null;
  if (timer) { clearTimeout(timer); timer = null; }
}
