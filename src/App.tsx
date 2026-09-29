import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { zodResolver } from '@hookform/resolvers/zod';
import { Alert, AppBar, Box, Button, Card, CardContent, Chip, Container, Divider, FormControl, Grid, InputLabel, MenuItem, Select, Stack, Tab, Tabs, TextField, Toolbar, Typography } from '@mui/material';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from 'react-redux';
import { z } from 'zod';
import { addField, addRule, publishVersion, reorderFields, selectPreview, useSchemaHistoryQuery, type FormField, type RootState } from './store';

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
  const active = state.versions.find((item) => item.id === state.previewVersionId) ?? state.versions[0];
  const snapshots = state.snapshots;
  const [tab, setTab] = useState(0);
  const [migration, setMigration] = useState<string | null>(null);
  const [runtimeResult, setRuntimeResult] = useState<Record<string, unknown> | null>(null);
  const [newRuleTarget, setNewRuleTarget] = useState(active.fields.at(-1)?.id ?? 'budgetCode');
  const sensors = useSensors(useSensor(PointerSensor));
  const { data: history = [] } = useSchemaHistoryQuery(active.id);
  const form = useForm<z.infer<typeof runtimeSchema>>({ resolver: zodResolver(runtimeSchema), defaultValues: { name: '', department: '', amount: 0, budgetCode: '', invoiceDate: '' } });

  function dragEnd(event: DragEndEvent) { if (event.over && event.active.id !== event.over.id) dispatch(reorderFields({ activeId: String(event.active.id), overId: String(event.over.id) })); }
  function simulate(snapshotId: string) {
    const snapshot = snapshots.find((item) => item.id === snapshotId);
    if (!snapshot) return;
    const missing = active.fields.filter((field) => field.required && !snapshot.data[field.id]).map((field) => field.label);
    setMigration(missing.length ? `旧数据缺少新版本必填字段：${missing.join('、')}。迁移时需要补充或使用默认值。` : '旧数据可以直接迁移到当前版本。');
  }

  return (
    <Box minHeight="100vh" bgcolor="#f7f8fc">
      <AppBar position="sticky" color="primary"><Toolbar><Typography variant="h6" flexGrow={1}>{t('title')}</Typography><Button color="inherit" onClick={() => dispatch(publishVersion())}>{t('publish')}</Button></Toolbar></AppBar>
      <Container maxWidth="xl" sx={{ py: 4 }}>
        <Grid container spacing={3}>
          <Grid size={{ xs: 12, lg: 7 }}>
            <Card><CardContent>
              <Stack direction="row" justifyContent="space-between" alignItems="center" mb={2}><div><Typography variant="h6">字段编排</Typography><Typography variant="body2" color="text.secondary">拖动调整字段顺序，发布后成为新的历史版本。</Typography></div><Button variant="contained" onClick={() => dispatch(addField())}>添加字段</Button></Stack>
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={dragEnd}><SortableContext items={active.fields.map((field) => field.id)} strategy={verticalListSortingStrategy}><Stack>{active.fields.map((field) => <SortableField key={field.id} field={field} />)}</Stack></SortableContext></DndContext>
              <Divider sx={{ my: 3 }} />
              <Typography variant="h6" mb={1}>联动规则</Typography>
              {[...active.rules, ...state.rules].map((rule) => <Alert key={rule.id} severity="info" sx={{ mb: 1 }}>{rule.fieldId} {rule.operator === 'equals' ? '等于' : '非空'} {rule.value || ''} 时，{rule.effect === 'require' ? '要求' : '显示'} {rule.targetId}</Alert>)}
              <Stack direction="row" spacing={2} mt={2}><FormControl size="small" fullWidth><InputLabel>目标字段</InputLabel><Select label="目标字段" value={newRuleTarget} onChange={(event) => setNewRuleTarget(event.target.value)}>{active.fields.map((field) => <MenuItem key={field.id} value={field.id}>{field.label}</MenuItem>)}</Select></FormControl><Button variant="outlined" onClick={() => dispatch(addRule({ fieldId: 'department', operator: 'equals', value: '财务', effect: 'require', targetId: newRuleTarget }))}>添加财务联动</Button></Stack>
            </CardContent></Card>
          </Grid>

          <Grid size={{ xs: 12, lg: 5 }}>
            <Card><CardContent>
              <Tabs value={tab} onChange={(_, value) => setTab(value)}><Tab label="版本差异" /><Tab label={t('simulate')} /><Tab label={t('runtime')} /></Tabs>
              {tab === 0 && <Box mt={2}><Typography fontWeight={700} mb={1}>v1 → {active.label}</Typography><Stack direction="row" gap={1} flexWrap="wrap">{active.fields.map((field) => <Chip key={field.id} label={`新增 ${field.label}`} color="success" variant="outlined" />)}</Stack><Alert severity="warning" sx={{ mt: 2 }}>旧版本解释保持冻结；过去提交的数据不会按新字段含义重新解释。</Alert><Typography mt={2} fontWeight={700}>其他历史版本</Typography>{history.map((version) => <Button key={version.id} fullWidth sx={{ justifyContent: 'space-between' }} onClick={() => dispatch(selectPreview(version.id))}>{version.label}<span>{version.createdAt}</span></Button>)}</Box>}
              {tab === 1 && <Box mt={2}><Typography fontWeight={700} mb={1}>选择旧数据快照</Typography>{snapshots.map((snapshot) => <Card key={snapshot.id} variant="outlined" sx={{ p: 2, mb: 1 }}><Typography>{snapshot.label}</Typography><Typography variant="body2" color="text.secondary" mb={1}>{JSON.stringify(snapshot.data)}</Typography><Button size="small" onClick={() => simulate(snapshot.id)}>模拟迁移</Button></Card>)}{migration && <Alert severity={migration.includes('缺少') ? 'warning' : 'success'}>{migration}</Alert>}</Box>}
              {tab === 2 && <Box component="form" mt={2} onSubmit={form.handleSubmit((values) => setRuntimeResult(values))}><Stack spacing={2}>{active.fields.map((field) => <TextField key={field.id} label={field.label} type={field.type === 'number' ? 'number' : 'text'} required={field.required} {...form.register(field.id as keyof z.infer<typeof runtimeSchema>, field.type === 'number' ? { valueAsNumber: true } : {})} error={Boolean(form.formState.errors[field.id as keyof typeof form.formState.errors])} helperText={form.formState.errors[field.id as keyof typeof form.formState.errors]?.message} />)}<Button type="submit" variant="contained">按当前版本提交</Button></Stack>{runtimeResult && <Alert severity="success" sx={{ mt: 2 }}>运行态数据：{JSON.stringify(runtimeResult)}</Alert>}<Alert severity="info" sx={{ mt: 2 }}>历史数据按创建时版本解释，不随字段新增而改变。</Alert></Box>}
            </CardContent></Card>
          </Grid>
        </Grid>
      </Container>
    </Box>
  );
}
