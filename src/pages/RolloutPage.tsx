import { useEffect, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  LinearProgress,
  MenuItem,
  Stack,
  Step,
  StepLabel,
  Stepper,
  TextField,
  Typography,
} from '@mui/material'
import PlayArrowOutlinedIcon from '@mui/icons-material/PlayArrowOutlined'
import UndoOutlinedIcon from '@mui/icons-material/UndoOutlined'
import PauseCircleOutlineIcon from '@mui/icons-material/PauseCircleOutline'
import { useGetFlagsQuery, useGetImpactQuery, useRollbackFlagMutation, useSaveFlagMutation } from '@/services/flagApi'
import { FlagStatusChip } from '@/components/FlagStatusChip'

export function RolloutPage() {
  const { data: flags = [], isLoading } = useGetFlagsQuery({})
  const { data: impact } = useGetImpactQuery(undefined)
  const [selectedId, setSelectedId] = useState('')
  const [rollbackOpen, setRollbackOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [message, setMessage] = useState('')
  const [saveFlag, saveState] = useSaveFlagMutation()
  const [rollbackFlag, rollbackState] = useRollbackFlagMutation()

  useEffect(() => {
    if (!selectedId && flags.length > 0) setSelectedId(flags[0].id)
  }, [flags, selectedId])

  const flag = flags.find((item) => item.id === selectedId)
  const flagImpact = impact?.flags.find((item) => item.flagId === selectedId)
  const currentStepIndex = flag?.rolloutSteps.findIndex((step) => step.status === 'running') ?? -1

  const advanceRollout = async () => {
    if (!flag) return
    const steps = flag.rolloutSteps.map((step, index) => ({
      ...step,
      status:
        index === currentStepIndex
          ? ('completed' as const)
          : index === currentStepIndex + 1
            ? ('running' as const)
            : step.status,
    }))
    const nextPercentage =
      steps.find((step) => step.status === 'running')?.percentage ?? flag.rolloutPercentage
    try {
      const result = await saveFlag({
        ...flag,
        rolloutSteps: steps,
        rolloutPercentage: nextPercentage,
        enabled: true,
        status: 'active',
        lastChangedBy: '林默',
      }).unwrap()
      const delta = result.event?.deltaUsers ?? 0
      setMessage(
        `灰度已推进至 ${nextPercentage}%，合计已按去重边际重算：净${delta >= 0 ? '新增' : '释放'} ${Math.abs(delta).toLocaleString()} 人，当前去重总影响 ${result.impact.totalUsers.toLocaleString()} 人`,
      )
    } catch {
      setMessage('推进入库失败，已从上一份完整记录重试，请重试该操作')
    }
  }

  const pauseRollout = async () => {
    if (!flag) return
    try {
      const result = await saveFlag({
        ...flag,
        status: 'frozen',
        lastChangedBy: '林默',
        rolloutSteps: flag.rolloutSteps.map((step) =>
          step.status === 'running' ? { ...step, status: 'paused' } : step,
        ),
      }).unwrap()
      setMessage(
        `灰度流量已冻结，覆盖人群保持不变（去重合计 ${result.impact.totalUsers.toLocaleString()} 人），现有用户继续使用当前配置`,
      )
    } catch {
      setMessage('冻结入库失败，请重试')
    }
  }

  const submitRollback = async () => {
    if (!flag || reason.trim().length < 8) {
      setMessage('回滚原因至少 8 个字符')
      return
    }
    try {
      const result = await rollbackFlag({ id: flag.id, actor: '林默', reason }).unwrap()
      setRollbackOpen(false)
      setReason('')
      setMessage(
        `已完成回滚：清零前核定释放 ${(result.event?.releasedUsers ?? 0).toLocaleString()} 名去重用户并写入审计日志，当前去重总影响 ${result.impact.totalUsers.toLocaleString()} 人`,
      )
    } catch {
      setMessage('回滚入库失败，已从上一份完整记录重试，请重试该操作')
    }
  }

  return (
    <Box>
      <Box className="page-heading">
        <Box>
          <Typography variant="h2">灰度发布时间线</Typography>
          <Typography color="text.secondary">
            逐步放量、冻结流量或回滚生产配置，每次变化都记录影响范围与操作者。
          </Typography>
        </Box>
        <TextField
          select
          label="发布目标"
          value={selectedId}
          onChange={(event) => setSelectedId(event.target.value)}
          sx={{ width: 300 }}
        >
          {flags.map((item) => <MenuItem key={item.id} value={item.id}>{item.name}</MenuItem>)}
        </TextField>
      </Box>

      {message && <Alert severity={message.includes('失败') ? 'error' : 'success'} onClose={() => setMessage('')} sx={{ mb: 2 }}>{message}</Alert>}
      {isLoading && <LinearProgress sx={{ mb: 2 }} />}

      {flag && (
        <>
          <Card sx={{ mb: 2 }}>
            <CardContent>
              <Stack direction="row" justifyContent="space-between" alignItems="flex-start" sx={{ mb: 1.5 }}>
                <Box>
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Typography variant="h3">{flag.name}</Typography>
                    <FlagStatusChip status={flag.status} />
                  </Stack>
                  <Typography variant="caption" color="text.secondary">{flag.key} · 当前 {flag.rolloutPercentage}%</Typography>
                </Box>
                <Stack direction="row" spacing={1}>
                  <Button variant="outlined" startIcon={<PauseCircleOutlineIcon />} onClick={() => void pauseRollout()} disabled={saveState.isLoading || flag.status === 'frozen'}>
                    冻结流量
                  </Button>
                  <Button variant="contained" startIcon={<PlayArrowOutlinedIcon />} onClick={() => void advanceRollout()} disabled={saveState.isLoading || currentStepIndex < 0 || currentStepIndex >= flag.rolloutSteps.length - 1}>
                    推进下一阶段
                  </Button>
                  <Button color="error" variant="outlined" startIcon={<UndoOutlinedIcon />} onClick={() => setRollbackOpen(true)}>
                    紧急回滚
                  </Button>
                </Stack>
              </Stack>
              <Stack direction="row" spacing={3} sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
                <Box>
                  <Typography variant="caption" color="text.secondary">本开关毛覆盖（含重叠）</Typography>
                  <Typography fontWeight={700}>{(flagImpact?.grossUsers ?? 0).toLocaleString()} 人</Typography>
                </Box>
                <Box>
                  <Typography variant="caption" color="text.secondary">去重边际（计入合计）</Typography>
                  <Typography fontWeight={700} color="primary.main">{(flagImpact?.marginalUsers ?? 0).toLocaleString()} 人</Typography>
                </Box>
                <Box>
                  <Typography variant="caption" color="text.secondary">与其他开关重叠</Typography>
                  <Typography fontWeight={700} color={(flagImpact?.overlapUsers ?? 0) > 0 ? 'warning.main' : undefined}>
                    {(flagImpact?.overlapUsers ?? 0).toLocaleString()} 人
                  </Typography>
                </Box>
                <Box>
                  <Typography variant="caption" color="text.secondary">全部开关去重总影响</Typography>
                  <Typography fontWeight={700}>{(impact?.totalUsers ?? 0).toLocaleString()} 人</Typography>
                </Box>
              </Stack>
              {(flagImpact?.overlaps.length ?? 0) > 0 && (
                <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                  {flagImpact?.overlaps.map((overlap) => (
                    <Chip
                      key={overlap.flagId}
                      size="small"
                      color="warning"
                      variant="outlined"
                      label={`与 ${overlap.flagKey} 重叠 ${overlap.users.toLocaleString()} 人（只计一次）`}
                    />
                  ))}
                </Stack>
              )}
              <Stepper activeStep={Math.max(currentStepIndex, 0)} alternativeLabel>
                {flag.rolloutSteps.map((step) => (
                  <Step key={step.id} completed={step.status === 'completed'}>
                    <StepLabel
                      optional={
                        <Typography variant="caption" color={step.status === 'paused' ? 'warning.main' : 'text.secondary'}>
                          {step.audience}
                        </Typography>
                      }
                    >
                      {step.percentage}% · {step.status === 'completed' ? '已完成' : step.status === 'running' ? '进行中' : step.status === 'paused' ? '已暂停' : '计划中'}
                    </StepLabel>
                  </Step>
                ))}
              </Stepper>
            </CardContent>
          </Card>

          <Box className="rollout-grid">
            <Card>
              <CardContent>
                <Typography variant="h3" sx={{ mb: 1.5 }}>阶段守护指标</Typography>
                {flag.rolloutSteps.map((step) => (
                  <Box key={step.id} className="guardrail-row">
                    <Box>
                      <Typography variant="body2" fontWeight={700}>{step.percentage}% · {step.audience}</Typography>
                      <Stack direction="row" spacing={0.7} sx={{ mt: 0.7 }} flexWrap="wrap" useFlexGap>
                        {step.guardrails.map((guardrail) => <Chip key={guardrail} size="small" variant="outlined" label={guardrail} />)}
                      </Stack>
                    </Box>
                    <Chip
                      size="small"
                      label={step.status === 'completed' ? '已通过' : step.status === 'running' ? '观察中' : step.status === 'paused' ? '已暂停' : '待执行'}
                      color={step.status === 'completed' ? 'success' : step.status === 'running' ? 'primary' : step.status === 'paused' ? 'warning' : 'default'}
                    />
                  </Box>
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardContent>
                <Typography variant="h3" sx={{ mb: 1.5 }}>环境差异与客户端约束</Typography>
                <Box className="environment-compare">
                  {(['dev', 'staging', 'production'] as const).map((environment) => {
                    const isOwner = flag.environment === environment
                    return (
                      <Box key={environment} sx={{ opacity: isOwner ? 1 : 0.5 }}>
                        <Typography variant="caption" color="text.secondary">{environment.toUpperCase()}</Typography>
                        <Typography className="summary-value">{isOwner ? `${flag.rolloutPercentage}%` : '—'}</Typography>
                        <Typography variant="caption">最低 {flag.minClientVersion[environment]}</Typography>
                      </Box>
                    )
                  })}
                </Box>
                <Alert severity="warning" sx={{ mt: 2 }}>
                  生产环境低于最低版本的用户会走降级路径，不会命中新逻辑。
                </Alert>
                <Typography variant="h3" sx={{ mt: 2.5, mb: 1 }}>回滚条件</Typography>
                {flag.rollbackConditions.map((condition) => <Typography key={condition} variant="body2">• {condition}</Typography>)}
              </CardContent>
            </Card>
          </Box>
        </>
      )}

      <Dialog open={rollbackOpen} onClose={() => setRollbackOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>确认紧急回滚</DialogTitle>
        <DialogContent dividers>
          <Alert severity="error" sx={{ mb: 2 }}>
            回滚会立即关闭开关、将灰度降至 0，并把所有运行中阶段标记为暂停。
          </Alert>
          <TextField
            label="回滚原因与异常证据"
            multiline
            minRows={3}
            fullWidth
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRollbackOpen(false)}>取消</Button>
          <Button color="error" variant="contained" loading={rollbackState.isLoading} onClick={() => void submitRollback()}>
            执行回滚
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
