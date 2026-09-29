import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import DeleteIcon from '@mui/icons-material/Delete';
import { zodResolver } from '@hookform/resolvers/zod';
import { Alert, AppBar, Box, Button, Card, CardContent, Chip, Container, Divider, FormControl, FormControlLabel, Grid, IconButton, InputLabel, LinearProgress, MenuItem, Select, Stack, Switch, Tab, Tabs, TextField, Toolbar, Typography } from '@mui/material';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from 'react-redux';
import { z } from 'zod';
import {
  addField, addRule, generateRecords, inspectVersion, migrateRecordOnRead, migrationRunAll, migrationTick,
  publishVersion, rebaseDraft, removeRule, reorderFields, retryMigration, startMigration,
  toggleSimulateFailure, useSchemaHistoryQuery, type FormField, type RootState
} from './store';

const runtimeSchema = z.object({
  name: z.string().min(2, '请输入申请名称'),
  department: z.string().min(1, '请选择部门'),
  amount: z.number().positive('金额必须大于0'),
  budgetCode: z.string().optional(),
  invoiceDate: z.string().optional()
}).superRefine((data, context) => {
  if (data.department === '财务' && !data.budgetCode) context.addIssue({ code: 'custom', path: ['budgetCode'], message: '财务部门必须填写预算科目' });
});

function SortableField({ field }: { field: FormField }) {
  const sortable = useSortable({ id: field.id });
  return (
    <Card ref={sortable.setNodeRef} variant="outlined" style={{ transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition }}>
      <CardContent sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', py: '14px !important' }}>
        <div><Typography fontWeight={700}>{field.label}</Typography><Typography variant="caption" color="text.secondary">{field.type} · {field.required ? '必填' : '选填'}</Typography></div>
        <Button size="small" {...sortable.attributes} {...sortable.listeners}>拖拽</Button>
      </CardContent>
    </Card>
  );
}

export default function App() {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const state = useSelector((root: RootState) => root.schema);
  const { draft } = state;
  const activeVersion = state.versions.find((item) => item.id === state.activeVersionId) ?? state.versions[0];
  const inspected = state.versions.find((item) => item.id === state.inspectVersionId) ?? activeVersion;
  const job = state.jobs[0];
  const [tab, setTab] = useState(0);
  const [runtimeResult, setRuntimeResult] = useState<Record<string, unknown> | null>(null);
  const [ruleSource, setRuleSource] = useState('department');
  const [ruleTarget, setRuleTarget] = useState('budgetCode');
  const [ruleEffect, setRuleEffect] = useState<'show' | 'require'>('require');
  const [sourceVersion, setSourceVersion] = useState('v1');
  const sensors = useSensors(useSensor(PointerSensor));
  const { data: history = [] } = useSchemaHistoryQuery(activeVersion.id);
  const form = useForm<z.infer<typeof runtimeSchema>>({ resolver: zodResolver(runtimeSchema), defaultValues: { name: '', department: '', amount: 0, budgetCode: '', invoiceDate: '' } });

  const addedFields = draft.fields.filter((field) => !activeVersion.fields.some((item) => item.id === field.id));
  const removedFields = activeVersion.fields.filter((field) => !draft.fields.some((item) => item.id === field.id));
  const addedRules = draft.rules.filter((rule) => !activeVersion.rules.some((item) => item.id === rule.id));
  const removedRules = activeVersion.rules.filter((rule) => !draft.rules.some((item) => item.id === rule.id));
  const oldRecords = state.snapshots.filter((item) => item.versionId !== state.activeVersionId);
  const jobTotal = job ? job.done.length + job.pending.length : 0;

  function dragEnd(event: DragEndEvent) { if (event.over && event.active.id !== event.over.id) dispatch(reorderFields({ activeId: String(event.active.id), overId: String(event.over.id) })); }

  return (
    <Box minHeight="100vh" bgcolor="#f7f8fc">
      <AppBar position="sticky" color="primary">
        <Toolbar>
          <Typography variant="h6" flexGrow={1}>{t('title')}</Typography>
          <Chip size="small" color={draft.conflict ? 'error' : 'default'} label={`草稿基线 ${draft.baseVersionId} / 当前 ${state.activeVersionId}`} sx={{ mr: 2 }} />
          <Button color="inherit" variant="outlined" onClick={() => dispatch(publishVersion())}>{t('publish')}</Button>
        </Toolbar>
      </AppBar>
      <Container maxWidth="xl" sx={{ py: 4 }}>
        {draft.conflict && (
          <Alert severity="error" sx={{ mb: 2 }}
            action={<Button color="inherit" size="small" onClick={() => dispatch(rebaseDraft())}>重新比对</Button>}>
            发布被拒绝：基线已变更为 {state.activeVersionId}（另一标签页发布了新版本）。草稿已保留，不会覆盖对方版本；请重新比对差异后再发布。
          </Alert>
        )}
        {state.publishError && <Alert severity="warning" sx={{ mb: 2 }}>{state.publishError}</Alert>}
        <Grid container spacing={3}>
          <Grid size={{ xs: 12, lg: 7 }}>
            <Card><CardContent>
              <Stack direction="row" justifyContent="space-between" alignItems="center" mb={2}>
                <div><Typography variant="h6">字段编排（草稿）</Typography><Typography variant="body2" color="text.secondary">基于 {draft.baseVersionId} 编辑；发布时编译不可变规则快照并检查循环依赖。</Typography></div>
                <Button variant="contained" onClick={() => dispatch(addField())}>添加字段</Button>
              </Stack>
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={dragEnd}>
                <SortableContext items={draft.fields.map((field) => field.id)} strategy={verticalListSortingStrategy}>
                  <Stack>{draft.fields.map((field) => <SortableField key={field.id} field={field} />)}</Stack>
                </SortableContext>
              </DndContext>
              <Divider sx={{ my: 3 }} />
              <Typography variant="h6" mb={1}>联动规则（草稿）</Typography>
              {draft.rules.map((rule) => (
                <Alert key={rule.id} severity="info" sx={{ mb: 1 }}
                  action={<IconButton size="small" onClick={() => dispatch(removeRule(rule.id))}><DeleteIcon fontSize="small" /></IconButton>}>
                  {rule.fieldId} {rule.operator === 'equals' ? `等于 ${rule.value}` : '非空'} 时，{rule.effect === 'require' ? '要求' : '显示'} {rule.targetId}
                </Alert>
              ))}
              <Stack direction="row" spacing={1} mt={2}>
                <FormControl size="small" fullWidth><InputLabel>源字段</InputLabel>
                  <Select label="源字段" value={ruleSource} onChange={(event) => setRuleSource(event.target.value)}>
                    {draft.fields.map((field) => <MenuItem key={field.id} value={field.id}>{field.label}</MenuItem>)}
                  </Select>
                </FormControl>
                <FormControl size="small" fullWidth><InputLabel>效果</InputLabel>
                  <Select label="效果" value={ruleEffect} onChange={(event) => setRuleEffect(event.target.value as 'show' | 'require')}>
                    <MenuItem value="require">要求</MenuItem><MenuItem value="show">显示</MenuItem>
                  </Select>
                </FormControl>
                <FormControl size="small" fullWidth><InputLabel>目标字段</InputLabel>
                  <Select label="目标字段" value={ruleTarget} onChange={(event) => setRuleTarget(event.target.value)}>
                    {draft.fields.map((field) => <MenuItem key={field.id} value={field.id}>{field.label}</MenuItem>)}
                  </Select>
                </FormControl>
                <Button variant="outlined" onClick={() => dispatch(addRule({ fieldId: ruleSource, operator: 'notEmpty', value: '', effect: ruleEffect, targetId: ruleTarget }))}>添加规则</Button>
              </Stack>
              <Typography variant="caption" color="text.secondary">提示：添加互相指向的规则（如 A→B 与 B→A）再发布，可验证循环依赖检查。</Typography>
            </CardContent></Card>
          </Grid>

          <Grid size={{ xs: 12, lg: 5 }}>
            <Card><CardContent>
              <Tabs value={tab} onChange={(_, value) => setTab(value)}>
                <Tab label="版本与快照" /><Tab label="迁移中心" /><Tab label={t('runtime')} />
              </Tabs>

              {tab === 0 && <Box mt={2}>
                <Typography fontWeight={700} mb={1}>草稿 vs 当前发布版（{activeVersion.label}）</Typography>
                <Stack direction="row" gap={1} flexWrap="wrap" mb={1}>
                  {addedFields.map((field) => <Chip key={field.id} label={`新增字段 ${field.label}`} color="success" variant="outlined" />)}
                  {removedFields.map((field) => <Chip key={field.id} label={`删除字段 ${field.label}`} color="error" variant="outlined" />)}
                  {addedRules.map((rule) => <Chip key={rule.id} label={`新增规则 ${rule.fieldId}→${rule.targetId}`} color="success" variant="outlined" />)}
                  {removedRules.map((rule) => <Chip key={rule.id} label={`删除规则 ${rule.fieldId}→${rule.targetId}`} color="error" variant="outlined" />)}
                  {!addedFields.length && !removedFields.length && !addedRules.length && !removedRules.length && <Chip label="草稿与当前版本无差异" variant="outlined" />}
                </Stack>
                <Alert severity="warning" sx={{ mt: 1 }}>旧数据回放仍按创建时版本解释；发布不会重新解释历史提交。</Alert>
                <Divider sx={{ my: 2 }} />
                <Typography fontWeight={700} mb={1}>已发布版本（含编译快照）</Typography>
                {state.versions.map((version) => (
                  <Card key={version.id} variant="outlined" sx={{ p: 1.5, mb: 1, cursor: 'pointer', borderColor: version.id === inspected.id ? 'primary.main' : undefined }} onClick={() => dispatch(inspectVersion(version.id))}>
                    <Stack direction="row" justifyContent="space-between" alignItems="center">
                      <Typography fontWeight={700}>{version.label}{version.id === state.activeVersionId && <Chip size="small" color="primary" label="当前" sx={{ ml: 1 }} />}</Typography>
                      <Typography variant="caption">{version.createdAt}</Typography>
                    </Stack>
                    {version.id === inspected.id && (
                      <Box mt={1}>
                        <Typography variant="body2">快照哈希 <code>{version.snapshot.hash}</code> · 编译于 {version.snapshot.compiledAt.slice(0, 19).replace('T', ' ')}</Typography>
                        <Typography variant="body2">求值顺序：{version.snapshot.evalOrder.length ? version.snapshot.evalOrder.join(' → ') : '（无规则）'}</Typography>
                        <Chip size="small" label="快照不可变 · 迁移后台只读" variant="outlined" sx={{ mt: 0.5 }} />
                      </Box>
                    )}
                  </Card>
                ))}
                <Typography mt={1} fontWeight={700}>其他历史版本</Typography>
                {history.map((version) => <Typography key={version.id} variant="body2" color="text.secondary">{version.label} · {version.createdAt}</Typography>)}
              </Box>}

              {tab === 1 && <Box mt={2}>
                <Stack direction="row" spacing={2} alignItems="center" mb={2} flexWrap="wrap">
                  <FormControl size="small" sx={{ minWidth: 140 }}><InputLabel>源版本</InputLabel>
                    <Select label="源版本" value={sourceVersion} onChange={(event) => setSourceVersion(event.target.value)}>
                      {state.versions.filter((version) => version.id !== state.activeVersionId).map((version) => <MenuItem key={version.id} value={version.id}>{version.label}</MenuItem>)}
                    </Select>
                  </FormControl>
                  <Button variant="contained" onClick={() => dispatch(startMigration(sourceVersion))} disabled={!oldRecords.length}>创建迁移任务</Button>
                  <Button variant="outlined" onClick={() => dispatch(generateRecords(120))}>生成 120 条旧数据</Button>
                  <FormControlLabel control={<Switch checked={state.simulateFailure} onChange={() => dispatch(toggleSimulateFailure())} />} label="模拟中途故障" />
                </Stack>
                {job && (
                  <Card variant="outlined" sx={{ p: 2, mb: 2 }}>
                    <Stack direction="row" justifyContent="space-between" alignItems="center" mb={1}>
                      <Typography fontWeight={700}>{job.fromVersionId} → {job.toVersionId}（快照 {job.snapshotHash}）</Typography>
                      <Chip size="small" color={job.status === 'done' ? 'success' : job.status === 'failed' ? 'error' : 'info'}
                        label={job.status === 'done' ? '已完成' : job.status === 'failed' ? '失败（进度已保留）' : '进行中'} />
                    </Stack>
                    <LinearProgress variant="determinate" value={jobTotal ? (job.done.length / jobTotal) * 100 : 0} sx={{ mb: 1 }} />
                    <Typography variant="body2" mb={1}>已完成 {job.done.length} / {jobTotal}，每批 {Math.min(25, jobTotal || 25)} 条，不一次性改写全部旧记录。</Typography>
                    {job.failed.map((failure) => <Alert key={failure.recordId} severity="error" sx={{ mb: 1 }}>{failure.recordId}：{failure.message}</Alert>)}
                    <Stack direction="row" spacing={1}>
                      <Button size="small" variant="outlined" disabled={job.status !== 'running'} onClick={() => dispatch(migrationTick())}>推进一批</Button>
                      <Button size="small" variant="outlined" disabled={job.status !== 'running'} onClick={() => dispatch(migrationRunAll())}>自动跑完</Button>
                      <Button size="small" variant="contained" color="warning" disabled={job.status !== 'failed'} onClick={() => dispatch(retryMigration())}>重试（只补未完成 {job.pending.length} 条）</Button>
                    </Stack>
                  </Card>
                )}
                <Typography fontWeight={700} mb={1}>旧数据（{oldRecords.length} 条待迁移，点击单条触发懒迁移）</Typography>
                {state.snapshots.slice(0, 8).map((snapshot) => (
                  <Card key={snapshot.id} variant="outlined" sx={{ p: 1.5, mb: 1, cursor: snapshot.versionId === state.activeVersionId ? 'default' : 'pointer' }} onClick={() => dispatch(migrateRecordOnRead(snapshot.id))}>
                    <Stack direction="row" justifyContent="space-between" alignItems="center">
                      <Typography variant="body2">{snapshot.label}</Typography>
                      <Chip size="small" color={snapshot.versionId === state.activeVersionId ? 'success' : 'default'} label={snapshot.versionId} />
                    </Stack>
                  </Card>
                ))}
                {state.snapshots.length > 8 && <Typography variant="caption" color="text.secondary">……共 {state.snapshots.length} 条，其余由迁移任务分批处理</Typography>}
                <Divider sx={{ my: 2 }} />
                <Typography fontWeight={700} mb={1}>审计记录（{state.audit.length}）</Typography>
                <Stack spacing={0.5} sx={{ maxHeight: 220, overflow: 'auto' }}>
                  {state.audit.map((entry) => (
                    <Alert key={entry.id} severity={entry.status === 'success' ? 'success' : 'error'} sx={{ py: 0 }}>
                      {entry.recordLabel}：{entry.fromVersionId} → {entry.toVersionId}（{entry.mode === 'lazy' ? '按需' : '批量'}）
                      {entry.status === 'success' ? `，补齐字段 ${entry.addedFields.length ? entry.addedFields.join('、') : '无'}` : `，${entry.message}`}
                    </Alert>
                  ))}
                  {!state.audit.length && <Typography variant="body2" color="text.secondary">暂无审计记录</Typography>}
                </Stack>
              </Box>}

              {tab === 2 && <Box component="form" mt={2} onSubmit={form.handleSubmit((values) => setRuntimeResult(values))}>
                <Stack spacing={2}>
                  {activeVersion.fields.map((field) => (
                    <TextField key={field.id} label={field.label} type={field.type === 'number' ? 'number' : 'text'} required={field.required}
                      {...form.register(field.id as keyof z.infer<typeof runtimeSchema>, field.type === 'number' ? { valueAsNumber: true } : {})}
                      error={Boolean(form.formState.errors[field.id as keyof typeof form.formState.errors])}
                      helperText={form.formState.errors[field.id as keyof typeof form.formState.errors]?.message} />
                  ))}
                  <Button type="submit" variant="contained">按当前版本（{activeVersion.id}）提交</Button>
                </Stack>
                {runtimeResult && <Alert severity="success" sx={{ mt: 2 }}>运行态数据：{JSON.stringify(runtimeResult)}</Alert>}
                <Alert severity="info" sx={{ mt: 2 }}>历史数据按创建时版本解释，不随字段新增而改变。</Alert>
              </Box>}
            </CardContent></Card>
          </Grid>
        </Grid>
      </Container>
    </Box>
  );
}
