import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import {
  Alert, AppBar, Box, Button, Card, CardContent, Chip, CircularProgress, Container, Divider,
  FormControl, Grid, IconButton, InputLabel, LinearProgress, MenuItem, Select, Stack, Tab,
  Tabs, TextField, Toolbar, Tooltip, Typography
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/DeleteOutline';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import PauseIcon from '@mui/icons-material/Pause';
import ReplayIcon from '@mui/icons-material/Replay';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { useMemo, useState, type ReactNode } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import type { TypedUseSelectorHook } from 'react-redux';
import { useDispatch, useSelector } from 'react-redux';
import {
  compileSnapshot, detectCycles, findRecord,
  type FormField, type LinkRule, type MigratedRecord
} from './engine';
import { armFailure, cancelRunner, resumeJob, startJob } from './migration';
import {
  addField, addRule, addSubmission, deleteField, deleteRule, lazyMigrateThunk,
  pauseMigration, publishDraft, rebaseDraft, reorderFields, retryMigration,
  store, updateField, useSchemaHistoryQuery, type AppDispatch, type RootState
} from './store';

const useAppDispatch = () => useDispatch<AppDispatch>();
const useAppSelector: TypedUseSelectorHook<RootState> = useSelector;

function SortableField({ field, onDelete, onUpdate }: {
  field: FormField;
  onDelete: (id: string) => void;
  onUpdate: (id: string, patch: Partial<Pick<FormField, 'label' | 'type' | 'required'>>) => void;
}) {
  const sortable = useSortable({ id: field.id });
  return (
    <Card ref={sortable.setNodeRef} variant="outlined" sx={{ mb: 1, transform: sortable.transform ? undefined : undefined }} style={{ transform: `translate3d(${sortable.transform?.x ?? 0}px, ${sortable.transform?.y ?? 0}px, 0)`, transition: sortable.transition }}>
      <CardContent sx={{ display: 'flex', gap: 1, alignItems: 'center', py: '12px !important', '&:last-child': { pb: '12px' } }}>
        <Button size="small" {...sortable.attributes} {...sortable.listeners} sx={{ cursor: 'grab', minWidth: 40 }}>☰</Button>
        <TextField size="small" label="字段名" value={field.label} onChange={(event) => onUpdate(field.id, { label: event.target.value })} sx={{ width: 160 }} />
        <FormControl size="small" sx={{ width: 120 }}>
          <InputLabel>类型</InputLabel>
          <Select label="类型" value={field.type} onChange={(event) => onUpdate(field.id, { type: event.target.value as FormField['type'] })}>
            <MenuItem value="text">文本</MenuItem>
            <MenuItem value="number">数字</MenuItem>
            <MenuItem value="select">下拉</MenuItem>
            <MenuItem value="date">日期</MenuItem>
          </Select>
        </FormControl>
        <FormControl size="small" sx={{ width: 110 }}>
          <InputLabel>必填</InputLabel>
          <Select label="必填" value={field.required ? 'yes' : 'no'} onChange={(event) => onUpdate(field.id, { required: event.target.value === 'yes' })}>
            <MenuItem value="yes">必填</MenuItem>
            <MenuItem value="no">选填</MenuItem>
          </Select>
        </FormControl>
        <Chip size="small" label={`id: ${field.id}`} variant="outlined" />
        <Box flex={1} />
        <IconButton size="small" color="error" onClick={() => onDelete(field.id)}><DeleteIcon /></IconButton>
      </CardContent>
    </Card>
  );
}

function ruleText(rule: LinkRule, fieldLabel: (id: string) => string): string {
  const cond = rule.operator === 'equals' ? `等于「${rule.value}」` : '非空';
  return `当【${fieldLabel(rule.fieldId)}】${cond} 时，${rule.effect === 'require' ? '要求必填' : '显示'}【${fieldLabel(rule.targetId)}】`;
}

export default function App() {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const state = useAppSelector((root) => root.schema);
  const { draft, conflict, publishError, headVersionId, snapshots, versions } = state;
  const head = versions.find((version) => version.id === headVersionId)!;
  const headSnapshot = snapshots.find((snapshot) => snapshot.versionId === headVersionId)!;

  const [tab, setTab] = useState(0);
  const [publishFlash, setPublishFlash] = useState<string | null>(null);
  const [newRule, setNewRule] = useState<Omit<LinkRule, 'id'>>({
    fieldId: 'department', operator: 'equals', value: '财务', effect: 'require', targetId: 'budgetCode'
  });

  // 草稿实时编译预览：发布前就能看到循环依赖/悬空引用
  const draftDiagnostic = useMemo(() => {
    const candidate = { id: 'draft', parentId: draft.baselineId, fields: draft.schema.fields, rules: draft.schema.rules };
    const snapshot = compileSnapshot(candidate);
    return { snapshot, cycles: detectCycles(snapshot.fields.map((f) => f.id), snapshot.edges) };
  }, [draft]);

  const fieldLabel = useMemo(() => {
    const map = new Map(draft.schema.fields.map((field) => [field.id, field.label]));
    return (id: string) => map.get(id) ?? `<已删除 ${id}>`;
  }, [draft.schema.fields]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const { data: history = [] } = useSchemaHistoryQuery(headVersionId);

  function dragEnd(event: DragEndEvent) {
    if (event.over && event.active.id !== event.over.id) {
      dispatch(reorderFields({ activeId: String(event.active.id), overId: String(event.over.id) }));
    }
  }

  function handlePublish() {
    const outcome = dispatch(publishDraft());
    if (outcome.ok) setPublishFlash('已发布新版本：不可变规则快照已编译落库，旧数据仍按各自原版本解释。');
    else setPublishFlash(null);
  }

  return (
    <Box minHeight="100vh" bgcolor="#f7f8fc">
      <AppBar position="sticky">
        <Toolbar>
          <Typography variant="h6" flexGrow={1}>{t('title')}</Typography>
          <Chip size="small" label={`当前发布版本 ${head.label} · ${head.createdAt}`} sx={{ color: '#fff', borderColor: '#ffffff88', mr: 2 }} variant="outlined" />
          <Button color="inherit" variant="outlined" onClick={handlePublish} startIcon={<PlayArrowIcon />}>发布新版本</Button>
        </Toolbar>
      </AppBar>

      <Container maxWidth="xl" sx={{ py: 3 }}>
        {publishFlash && <Alert severity="success" sx={{ mb: 2 }} onClose={() => setPublishFlash(null)}>{publishFlash}</Alert>}
        {conflict && (
          <Alert
            severity="warning"
            icon={<WarningAmberIcon />}
            sx={{ mb: 2 }}
            action={<Button color="inherit" size="small" onClick={() => dispatch(rebaseDraft())}>重新比对（以新版本为基线）</Button>}
          >
            <Typography fontWeight={700}>发布被拒绝：{conflict.reason}</Typography>
            对方已发布「{conflict.remoteLabel}」。你的草稿已原样保留、未被覆盖；请重新比对差异后再决定合并还是放弃。
          </Alert>
        )}
        {!conflict && state.baselineDrift && (
          <Alert
            severity="info"
            sx={{ mb: 2 }}
            action={<Button color="inherit" size="small" onClick={() => dispatch(rebaseDraft())}>切换到新版本</Button>}
          >
            其他标签页刚发布了「{state.baselineDrift.remoteLabel}」。本页草稿与基线一致、没有本地改动，可直接切换。
          </Alert>
        )}
        {publishError && (
          <Alert severity="error" sx={{ mb: 2 }}>
            <Typography fontWeight={700}>发布前校验未通过：{publishError.message}</Typography>
            {publishError.cycles.map((cycle, index) => (
              <div key={index}>循环依赖：{cycle.map((id) => fieldLabel(id)).join(' → ')}</div>
            ))}
            {publishError.dangling.map((ref, index) => (
              <div key={`d-${index}`}>规则 {ref.ruleId} 引用了已删除字段 {ref.fieldId}（{ref.kind === 'source' ? '触发字段' : '目标字段'}）</div>
            ))}
          </Alert>
        )}

        <Grid container spacing={3}>
          <Grid size={{ xs: 12, lg: 7 }}>
            <Card>
              <CardContent>
                <Stack direction="row" justifyContent="space-between" alignItems="center" mb={2}>
                  <div>
                    <Typography variant="h6">字段与联动编排（草稿）</Typography>
                    <Typography variant="body2" color="text.secondary">
                      草稿基线：{draft.baselineId}（指纹 {draft.baselineFingerprint}）{draft.dirty ? ' · 有未发布修改' : ' · 与已发布版本一致'}
                    </Typography>
                  </div>
                  <Button variant="contained" onClick={() => dispatch(addField())}>添加字段</Button>
                </Stack>

                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={dragEnd}>
                  <SortableContext items={draft.schema.fields.map((field) => field.id)} strategy={verticalListSortingStrategy}>
                    {draft.schema.fields.map((field) => (
                      <SortableField key={field.id} field={field} onDelete={(id) => dispatch(deleteField(id))} onUpdate={(id, patch) => dispatch(updateField({ id, patch }))} />
                    ))}
                  </SortableContext>
                </DndContext>

                <Divider sx={{ my: 3 }} />
                <Typography variant="h6" mb={1}>联动规则</Typography>
                {draft.schema.rules.length === 0 && <Typography variant="body2" color="text.secondary">暂无规则</Typography>}
                {draft.schema.rules.map((rule) => {
                  const dangling = draftDiagnostic.snapshot.danglingRefs.some((ref) => ref.ruleId === rule.id);
                  return (
                    <Alert
                      key={rule.id}
                      severity={dangling ? 'error' : 'info'}
                      sx={{ mb: 1, alignItems: 'center' }}
                      action={<IconButton size="small" color="error" onClick={() => dispatch(deleteRule(rule.id))}><DeleteIcon /></IconButton>}
                    >
                      {ruleText(rule, fieldLabel)}{dangling && '（引用已删除字段，禁止发布）'}
                    </Alert>
                  );
                })}

                <Stack direction="row" spacing={1} mt={2} flexWrap="wrap" useFlexGap>
                  <FormControl size="small" sx={{ width: 150 }}>
                    <InputLabel>触发字段</InputLabel>
                    <Select label="触发字段" value={newRule.fieldId} onChange={(e) => setNewRule({ ...newRule, fieldId: e.target.value })}>
                      {draft.schema.fields.map((field) => <MenuItem key={field.id} value={field.id}>{field.label}</MenuItem>)}
                    </Select>
                  </FormControl>
                  <FormControl size="small" sx={{ width: 120 }}>
                    <InputLabel>条件</InputLabel>
                    <Select label="条件" value={newRule.operator} onChange={(e) => setNewRule({ ...newRule, operator: e.target.value as LinkRule['operator'] })}>
                      <MenuItem value="equals">等于</MenuItem>
                      <MenuItem value="notEmpty">非空</MenuItem>
                    </Select>
                  </FormControl>
                  <TextField size="small" label="比较值" value={newRule.value} onChange={(e) => setNewRule({ ...newRule, value: e.target.value })} sx={{ width: 110 }} />
                  <FormControl size="small" sx={{ width: 130 }}>
                    <InputLabel>效果</InputLabel>
                    <Select label="效果" value={newRule.effect} onChange={(e) => setNewRule({ ...newRule, effect: e.target.value as LinkRule['effect'] })}>
                      <MenuItem value="show">显示</MenuItem>
                      <MenuItem value="require">要求必填</MenuItem>
                    </Select>
                  </FormControl>
                  <FormControl size="small" sx={{ width: 150 }}>
                    <InputLabel>目标字段</InputLabel>
                    <Select label="目标字段" value={newRule.targetId} onChange={(e) => setNewRule({ ...newRule, targetId: e.target.value })}>
                      {draft.schema.fields.map((field) => <MenuItem key={field.id} value={field.id}>{field.label}</MenuItem>)}
                    </Select>
                  </FormControl>
                  <Button variant="outlined" onClick={() => dispatch(addRule(newRule))}>添加规则</Button>
                </Stack>

                <Box mt={2}>
                  <Typography variant="subtitle2" color="text.secondary">实时编译检查（发布闸口预览）</Typography>
                  {draftDiagnostic.cycles.length === 0 && draftDiagnostic.snapshot.danglingRefs.length === 0 ? (
                    <Chip size="small" color="success" label={`快照可编译：${draftDiagnostic.snapshot.edges.length} 条联动边，无循环依赖`} />
                  ) : (
                    <Stack spacing={1} mt={1}>
                      {draftDiagnostic.cycles.map((cycle, index) => (
                        <Alert key={index} severity="error">循环依赖：{cycle.map((id) => fieldLabel(id)).join(' → ')}（发布将被拒绝）</Alert>
                      ))}
                      {draftDiagnostic.snapshot.danglingRefs.map((ref, index) => (
                        <Alert key={`dangling-${index}`} severity="error">规则 {ref.ruleId} 引用已删除字段 {ref.fieldId}（{ref.kind === 'source' ? '触发字段' : '目标字段'}）</Alert>
                      ))}
                    </Stack>
                  )}
                </Box>
              </CardContent>
            </Card>
          </Grid>

          <Grid size={{ xs: 12, lg: 5 }}>
            <Card>
              <CardContent>
                <Tabs value={tab} onChange={(_, value) => setTab(value)} variant="fullWidth">
                  <Tab label="版本差异" />
                  <Tab label="旧数据回放/迁移" />
                  <Tab label={t('runtime')} />
                </Tabs>
                {tab === 0 && <VersionsTab history={history} head={head} />}
                {tab === 1 && <MigrationTab />}
                {tab === 2 && <RuntimeTab />}
              </CardContent>
            </Card>
          </Grid>
        </Grid>
      </Container>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Tab 1：版本差异（已发布版本均不可变）
// ---------------------------------------------------------------------------

function VersionsTab({ history, head }: { history: { id: string; label: string; createdAt: string; parentId: string | null }[]; head: { id: string; label: string } }) {
  const state = useAppSelector((root) => root.schema);
  const headSnapshot = state.snapshots.find((snapshot) => snapshot.versionId === head.id)!;
  const base = state.snapshots.find((snapshot) => snapshot.versionId === state.draft.baselineId) ?? state.snapshots[0];
  const added = headSnapshot.fields.filter((field) => !base.fields.some((old) => old.id === field.id));
  const removed = base.fields.filter((field) => !headSnapshot.fields.some((now) => now.id === field.id));
  const ruleAdded = headSnapshot.rules.filter((rule) => !base.rules.some((old) => old.id === rule.id));
  return (
    <Box mt={2}>
      <Typography fontWeight={700} mb={1}>{base.versionId} → {head.label}</Typography>
      <Typography variant="body2" color="text.secondary" mb={1}>
        快照指纹 {base.fingerprint} → {headSnapshot.fingerprint} · 编译于 {new Date(headSnapshot.compiledAt).toLocaleString()}
      </Typography>
      <Stack direction="row" gap={1} flexWrap="wrap">
        {added.map((field) => <Chip key={field.id} size="small" color="success" variant="outlined" label={`新增字段 ${field.label}`} />)}
        {removed.map((field) => <Chip key={field.id} size="small" color="error" variant="outlined" label={`删除字段 ${field.label}`} />)}
        {ruleAdded.map((rule) => <Chip key={rule.id} size="small" color="info" variant="outlined" label={`新增规则 ${rule.id}`} />)}
        {added.length + removed.length + ruleAdded.length === 0 && <Chip size="small" variant="outlined" label="结构无差异" />}
      </Stack>
      <Alert severity="info" sx={{ mt: 2 }}>已发布快照不可变：旧数据回放始终读记录提交时版本的快照，绝不按当前草稿重新解释。</Alert>
      <Typography mt={2} fontWeight={700}>版本链（parent → child）</Typography>
      {[...state.versions].reverse().map((version) => (
        <Box key={version.id} sx={{ py: 0.5 }}>
          <Chip size="small" label={`${version.id}`} color={version.id === state.headVersionId ? 'primary' : 'default'} sx={{ mr: 1 }} />
          {version.label} <Typography component="span" variant="caption" color="text.secondary">基于 {version.parentId ?? '根版本'} · {version.createdAt}</Typography>
        </Box>
      ))}
      <Typography mt={2} fontWeight={700}>其他历史版本（RTK Query）</Typography>
      {history.map((version) => (
        <Box key={version.id} sx={{ py: 0.3 }}>{version.label} <Typography component="span" variant="caption" color="text.secondary">{version.createdAt}</Typography></Box>
      ))}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Tab 2：旧数据懒回放 + 后台分批迁移（断点续跑、审计回写）
// ---------------------------------------------------------------------------

function MigrationTab() {
  const dispatch = useAppDispatch();
  const state = useAppSelector((root) => root.schema);
  const [recordQuery, setRecordQuery] = useState('rec-000001');
  const [lazyView, setLazyView] = useState<{ source: string; migrated?: MigratedRecord; error?: string } | null>(null);
  const [showAudit, setShowAudit] = useState(false);
  const job = state.migrationJob;
  const targetVersionId = state.headVersionId;
  const targetSnapshot = state.snapshots.find((snapshot) => snapshot.versionId === targetVersionId)!;

  function replay(id: string) {
    const record = findRecord(id.trim());
    if (!record) { setLazyView({ source: id.trim(), error: '未找到该记录（请输入 rec-000001 ~ rec-030000）' }); return; }
    const outcome = dispatch(lazyMigrateThunk(record, targetVersionId));
    setLazyView({ source: id.trim(), ...(outcome.error ? { error: outcome.error } : { migrated: outcome.result }) });
  }

  const migratedBucket = state.migratedIds[targetVersionId] ?? [];

  return (
    <Box mt={2}>
      <Typography fontWeight={700}>旧数据按原版本懒回放</Typography>
      <Typography variant="body2" color="text.secondary" mb={1}>
        30,000 条历史单据（v1 占 60%、v2 占 40%）。回放时读记录自带版本的不可变快照；迁移按版本链懒执行并回写审计，不一次性改写全量数据。
      </Typography>
      <Stack direction="row" spacing={1}>
        <TextField size="small" label="记录编号" value={recordQuery} onChange={(e) => setRecordQuery(e.target.value)} sx={{ flex: 1 }} />
        <Button variant="contained" onClick={() => replay(recordQuery)}>按 {targetVersionId} 回放</Button>
      </Stack>
      {lazyView && <LazyView view={lazyView} targetSnapshotFields={targetSnapshot.fields} />}

      <Divider sx={{ my: 2 }} />
      <Typography fontWeight={700}>后台迁移作业（v1/v2 → {targetVersionId}）</Typography>
      {!job && (
        <Stack direction="row" spacing={1} mt={1} flexWrap="wrap" useFlexGap>
          <Button variant="contained" size="small" startIcon={<PlayArrowIcon />} onClick={() => startJob(dispatch, store.getState, { fromVersion: 'v1', targetVersion: targetVersionId })}>
            启动后台迁移
          </Button>
          <Tooltip title="迁移处理 800 条后注入一次错误，演示进度保留与重试补齐">
            <Button variant="outlined" size="small" color="warning" startIcon={<WarningAmberIcon />} onClick={() => { armFailure(800); startJob(dispatch, store.getState, { fromVersion: 'v1', targetVersion: targetVersionId }); }}>
              启动并在中途注入错误
            </Button>
          </Tooltip>
        </Stack>
      )}
      {job && (
        <Box mt={1}>
          <Stack direction="row" spacing={1} alignItems="center" mb={1}>
            <StatusChip status={job.status} />
            <Typography variant="body2">{job.processed} / {job.total} 条已完成</Typography>
            <Box flex={1} />
            {job.status === 'running' && <Button size="small" startIcon={<PauseIcon />} onClick={() => { cancelRunner(); dispatch(pauseMigration()); }}>暂停</Button>}
            {job.status === 'paused' && <Button size="small" variant="contained" startIcon={<PlayArrowIcon />} onClick={() => { const owner = `tab-${Math.random().toString(36).slice(2, 10)}`; dispatch(retryMigration({ owner })); resumeJob(dispatch, store.getState, owner); }}>继续</Button>}
            {(job.status === 'error') && (
              <Button size="small" variant="contained" color="primary" startIcon={<ReplayIcon />} onClick={() => {
                const owner = `tab-${Math.random().toString(36).slice(2, 10)}`;
                dispatch(retryMigration({ owner }));
                resumeJob(dispatch, store.getState, owner);
              }}>重试（只补未完成）</Button>
            )}
          </Stack>
          <LinearProgress variant="determinate" value={Math.round((job.processed / Math.max(1, job.total)) * 100)} />
          {job.lastError && <Alert severity="error" sx={{ mt: 1 }}>{job.lastError}
            <Typography variant="caption" display="block">已完成 {job.processed} 条的进度与审计均已保留；重试会跳过这些记录，仅补跑未完成/失败部分。</Typography>
          </Alert>}
          {job.status === 'done' && <Alert severity="success" sx={{ mt: 1 }}>迁移完成：{job.total} 条旧记录均已按版本链映射到 {job.toVersion}，每条均有审计记录。</Alert>}
        </Box>
      )}
      <Typography variant="body2" color="text.secondary" mt={1}>
        本版本已回写迁移标记 {migratedBucket.length} 条 · 累计审计 {state.audit.length} 条
        <Button size="small" onClick={() => setShowAudit((v) => !v)}>{showAudit ? '收起审计' : '查看最近审计'}</Button>
      </Typography>
      {showAudit && <AuditList />}
      <Alert severity="info" sx={{ mt: 2 }}>
        在另一个浏览器标签页打开本应用并抢先发布：本页点击发布时会发现基线指纹/head 已变，草稿被保留并提示重新比对，不会覆盖对方版本。
      </Alert>
    </Box>
  );
}

function StatusChip({ status }: { status: string }) {
  const map: Record<string, { color: 'success' | 'warning' | 'error' | 'info' | 'default'; text: string }> = {
    ready: { color: 'default', text: '待执行' },
    running: { color: 'info', text: '迁移中' },
    paused: { color: 'warning', text: '已暂停' },
    error: { color: 'error', text: '出错中断' },
    done: { color: 'success', text: '已完成' }
  };
  const item = map[status] ?? { color: 'default' as const, text: status };
  return <Chip size="small" color={item.color} label={item.text} />;
}

function LazyView({ view, targetSnapshotFields }: {
  view: { source: string; migrated?: MigratedRecord; error?: string };
  targetSnapshotFields: FormField[];
}) {
  if (view.error) return <Alert severity="error" sx={{ mt: 1 }}>{view.error}</Alert>;
  const migrated = view.migrated!;
  const original = migrated.record.versionId;
  return (
    <Card variant="outlined" sx={{ mt: 1, p: 1.5 }}>
      <Stack direction="row" spacing={1} alignItems="center" mb={1}>
        <Chip size="small" label={migrated.migrated ? `原版本 ${original}` : `已是 ${original}`} color={migrated.migrated ? 'warning' : 'success'} />
        {migrated.migrated && <Typography variant="body2">迁移路径：{migrated.path.join(' → ')}</Typography>}
      </Stack>
      <Typography variant="caption" color="text.secondary">按原版本快照解释（不会被当前草稿重新解释）：</Typography>
      <Box component="pre" sx={{ bgcolor: '#f4f6fa', p: 1, borderRadius: 1, fontSize: 12, overflow: 'auto', m: '4px 0' }}>
        {JSON.stringify(migrated.record.data, null, 1)}
      </Box>
      {migrated.migrated && (
        <>
          <Typography variant="caption" color="text.secondary">字段映射（每一步均来自不可变快照）：</Typography>
          {migrated.changes.map((change, index) => (
            <Typography key={index} variant="caption" display="block">
              {change.step.from} → {change.step.to}：
              新增 [{change.added.join(', ') || '无'}] · 删除 [{change.removed.join(', ') || '无'}] · 类型转换 [{change.coerced.join(', ') || '无'}]
            </Typography>
          ))}
        </>
      )}
      <Typography variant="caption" display="block" mt={1}>
        目标版本字段数 {targetSnapshotFields.length}；本次访问已触发懒迁移并回写一条审计。
      </Typography>
    </Card>
  );
}

function AuditList() {
  const audit = useAppSelector((root) => root.schema.audit);
  const recent = [...audit].slice(-15).reverse();
  return (
    <Box sx={{ maxHeight: 220, overflow: 'auto', mt: 1, border: '1px solid #e3e7ef', borderRadius: 1 }}>
      {recent.map((tuple, index) => (
        <Box key={`${tuple[0]}-${tuple[3]}-${index}`} sx={{ px: 1, py: 0.4, borderBottom: '1px solid #f0f2f7', fontSize: 12 }}>
          <Chip size="small" sx={{ height: 18, fontSize: 11, mr: 0.5 }} color={tuple[4] === 'lazy' ? 'secondary' : 'primary'} label={tuple[4] === 'lazy' ? '懒迁移' : '批处理'} />
          {new Date(tuple[3]).toLocaleTimeString()} {tuple[0]}：{tuple[1]} → {tuple[2]}（+{tuple[5]}/-{tuple[6]} 字段）
        </Box>
      ))}
      {recent.length === 0 && <Typography variant="caption" sx={{ p: 1, display: 'block' }} color="text.secondary">暂无审计</Typography>}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Tab 3：运行态表单（按当前 head 快照的字段动态生成）
// ---------------------------------------------------------------------------

function RuntimeTab() {
  const dispatch = useAppDispatch();
  const state = useAppSelector((root) => root.schema);
  const headSnapshot = state.snapshots.find((snapshot) => snapshot.versionId === state.headVersionId)!;
  type FormValues = Record<string, string>;
  const { register, handleSubmit, watch, control, formState: { errors }, reset } = useForm<FormValues>({
    defaultValues: Object.fromEntries(headSnapshot.fields.map((field) => [field.id, '']))
  });
  const values = watch();

  // 依据不可变快照的联动边做显示/必填判定
  function visible(fieldId: string): boolean {
    return headSnapshot.rules.filter((rule) => rule.effect === 'show').every((rule) => {
      if (rule.targetId !== fieldId) return true;
      return rule.operator === 'notEmpty' ? Boolean(values[rule.fieldId]) : values[rule.fieldId] === rule.value;
    });
  }
  function requiredByRule(fieldId: string): LinkRule | undefined {
    return headSnapshot.rules.find((rule) => rule.effect === 'require' && rule.targetId === fieldId &&
      (rule.operator === 'notEmpty' ? Boolean(values[rule.fieldId]) : values[rule.fieldId] === rule.value));
  }

  const [submitted, setSubmitted] = useState<FormValues | null>(null);

  return (
    <Box mt={2}>
      <Typography variant="body2" color="text.secondary" mb={2}>按已发布快照 {state.headVersionId} 渲染（新提交会被盖上该版本戳记）。</Typography>
      <form onSubmit={handleSubmit((data) => {
        const visibleData = Object.fromEntries(Object.entries(data).filter(([id]) => visible(id)));
        dispatch(addSubmission(visibleData));
        setSubmitted(visibleData);
        reset();
      })}>
        <Stack spacing={2}>
          {headSnapshot.fields.map((field) => {
            if (!visible(field.id)) return null;
            const ruleRequired = requiredByRule(field.id);
            const required = field.required || Boolean(ruleRequired);
            return (
              <Controller key={field.id} control={control} name={field.id} render={() => (
                <TextField
                  size="small"
                  label={`${field.label}${ruleRequired ? '（联动必填）' : ''}`}
                  type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
                  required={required}
                  {...register(field.id, { required: required ? `${field.label}为必填` : false })}
                  error={Boolean(errors[field.id])}
                  helperText={errors[field.id]?.message as ReactNode}
                  InputLabelProps={field.type === 'date' ? { shrink: true } : undefined}
                />
              )} />
            );
          })}
          <Button type="submit" variant="contained">提交（按 {state.headVersionId} 版本解释）</Button>
        </Stack>
      </form>
      {submitted && <Alert severity="success" sx={{ mt: 2 }}>已提交并标记版本 {state.headVersionId}：{JSON.stringify(submitted)}</Alert>}
      {state.submissions.length > 0 && (
        <Box mt={2}>
          <Typography fontWeight={700} variant="body2">本会话新提交（带版本戳记）</Typography>
          {state.submissions.slice(0, 5).map((submission) => (
            <Box key={submission.id} sx={{ fontSize: 12, py: 0.3 }}>
              <Chip size="small" sx={{ height: 18, fontSize: 11, mr: 0.5 }} label={submission.versionId} />
              {submission.label} — {JSON.stringify(submission.data)}
            </Box>
          ))}
        </Box>
      )}
      {state.migrationJob && state.migrationJob.status === 'running' && (
        <Stack direction="row" spacing={1} alignItems="center" mt={2}>
          <CircularProgress size={16} />
          <Typography variant="caption">后台迁移进行中，不影响当前表单使用。</Typography>
        </Stack>
      )}
    </Box>
  );
}
