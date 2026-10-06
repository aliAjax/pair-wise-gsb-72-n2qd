import { useState } from 'react'
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
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material'
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined'
import UndoOutlinedIcon from '@mui/icons-material/UndoOutlined'
import { Link } from 'react-router-dom'
import { useGetAuditQuery, useGetFlagsQuery, useGetImpactQuery, useRollbackFlagMutation } from '@/services/flagApi'
import { FlagStatusChip } from '@/components/FlagStatusChip'

const actionLabel: Record<string, string> = {
  created: '创建',
  updated: '更新',
  submitted: '提交评审',
  approved: '批准',
  rejected: '驳回',
  frozen: '冻结',
  unfrozen: '解冻',
  'rolled-back': '回滚',
  'rollout-adjusted': '调整灰度',
}

export function AuditPage() {
  const { data: flags = [] } = useGetFlagsQuery({})
  const [flagId, setFlagId] = useState('')
  const [action, setAction] = useState('')
  const { data: events = [], isLoading } = useGetAuditQuery({ flagId: flagId || undefined, action: action || undefined })
  // 与概览、报告同源的去重口径快照，不再把每条审计记录的人数简单相加
  const { data: impact } = useGetImpactQuery(undefined)
  const [rollbackFlag, rollbackState] = useRollbackFlagMutation()
  const [selectedFlagId, setSelectedFlagId] = useState('')
  const [reason, setReason] = useState('')
  const [message, setMessage] = useState('')

  const selectedFlag = flags.find((flag) => flag.id === selectedFlagId)

  const rollbackEvents = events.filter((event) => event.action === 'rolled-back')
  const totalReleased = rollbackEvents.reduce((sum, event) => sum + (event.releasedUsers ?? event.affectedUsers), 0)

  const submitRollback = async () => {
    if (!selectedFlag || reason.trim().length < 8) {
      setMessage('回滚原因至少 8 个字符')
      return
    }
    try {
      const result = await rollbackFlag({ id: selectedFlag.id, actor: '林默', reason }).unwrap()
      setSelectedFlagId('')
      setReason('')
      setMessage(
        `回滚已执行，清零前核定释放 ${(result.event?.releasedUsers ?? 0).toLocaleString()} 名去重用户，并已写入审计记录`,
      )
    } catch {
      setMessage('回滚入库失败，已从上一份完整记录重试，请重试该操作')
    }
  }

  return (
    <Box>
      <Box className="page-heading">
        <Box>
          <Typography variant="h2">审计与回滚</Typography>
          <Typography color="text.secondary">
            查看每次配置调整、审批、冻结和异常回滚记录，并追踪受影响用户范围。
          </Typography>
        </Box>
        <Button variant="outlined" startIcon={<DownloadOutlinedIcon />} onClick={() => window.print()}>
          打印审计记录
        </Button>
      </Box>

      {message && <Alert severity={message.includes('失败') ? 'error' : 'success'} onClose={() => setMessage('')} sx={{ mb: 2 }}>{message}</Alert>}

      <Box className="audit-summary">
        <Box><Typography variant="caption">审计事件</Typography><Typography className="summary-value">{events.length}</Typography></Box>
        <Box><Typography variant="caption">回滚操作</Typography><Typography className="summary-value">{rollbackEvents.length}</Typography></Box>
        <Box>
          <Typography variant="caption">当前影响用户（去重合计）</Typography>
          <Typography className="summary-value">{(impact?.totalUsers ?? 0).toLocaleString()}</Typography>
        </Box>
        <Box>
          <Typography variant="caption">回滚累计释放</Typography>
          <Typography className="summary-value">{totalReleased.toLocaleString()}</Typography>
        </Box>
      </Box>

      <Alert severity={(impact?.overlapUsers ?? 0) > 0 ? 'info' : 'success'} sx={{ mb: 2 }}>
        影响合计采用与概览、发布报告相同的去重边际口径：简单求和 {(impact?.grossUsers ?? 0).toLocaleString()} 人，
        去重后 {(impact?.totalUsers ?? 0).toLocaleString()} 人，{(impact?.overlapUsers ?? 0).toLocaleString()} 名用户被多个开关命中但只计一次；
        不再把各条审计记录的影响人数直接相加。
      </Alert>

      <Card sx={{ mb: 2 }}>
        <CardContent>
          <Stack direction="row" spacing={1.5}>
            <TextField select label="功能开关" value={flagId} onChange={(event) => setFlagId(event.target.value)} sx={{ width: 280 }}>
              <MenuItem value="">全部开关</MenuItem>
              {flags.map((flag) => <MenuItem key={flag.id} value={flag.id}>{flag.name}</MenuItem>)}
            </TextField>
            <TextField select label="操作类型" value={action} onChange={(event) => setAction(event.target.value)} sx={{ width: 180 }}>
              <MenuItem value="">全部操作</MenuItem>
              {Object.entries(actionLabel).map(([value, label]) => <MenuItem key={value} value={value}>{label}</MenuItem>)}
            </TextField>
          </Stack>
        </CardContent>
      </Card>

      {isLoading && <LinearProgress sx={{ mb: 2 }} />}

      <Card>
        <TableContainer>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>时间 / 操作</TableCell>
                <TableCell>功能开关</TableCell>
                <TableCell>变更说明</TableCell>
                <TableCell>状态变化</TableCell>
                <TableCell>影响用户</TableCell>
                <TableCell align="right">操作</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {events.map((event) => {
                const relatedFlag = flags.find((flag) => flag.id === event.flagId)
                return (
                  <TableRow key={event.id} hover>
                    <TableCell>
                      <Typography variant="body2" fontWeight={700}>{actionLabel[event.action] ?? event.action}</Typography>
                      <Typography variant="caption" color="text.secondary">
                        {event.createdAt.slice(0, 16).replace('T', ' ')} · {event.actor}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography component={Link} to={`/flags/${event.flagId}`} variant="body2" fontWeight={700}>{event.flagKey}</Typography>
                      {relatedFlag && <FlagStatusChip status={relatedFlag.status} />}
                    </TableCell>
                    <TableCell sx={{ maxWidth: 420 }}>{event.summary}</TableCell>
                    <TableCell>
                      <Chip size="small" variant="outlined" label={`${event.before || '-'} → ${event.after || '-'}`} />
                    </TableCell>
                    <TableCell>
                      {event.action === 'rolled-back' ? (
                        <>
                          <Typography variant="body2" fontWeight={700} color="success.main">
                            释放 {(event.releasedUsers ?? event.affectedUsers).toLocaleString()}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">清零前核定，去重边际</Typography>
                        </>
                      ) : (event.deltaUsers ?? 0) !== 0 ? (
                        <>
                          <Typography
                            variant="body2"
                            fontWeight={700}
                            color={(event.deltaUsers ?? 0) > 0 ? 'error.main' : 'success.main'}
                          >
                            {(event.deltaUsers ?? 0) > 0 ? '+' : ''}
                            {(event.deltaUsers ?? 0).toLocaleString()}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">净变化 · 去重边际</Typography>
                        </>
                      ) : (
                        <>
                          <Typography variant="body2">{event.affectedUsers.toLocaleString()}</Typography>
                          <Typography variant="caption" color="text.secondary">
                            {event.grossUsers ? `毛覆盖 ${event.grossUsers.toLocaleString()} · 去重后净变化为 0` : '无放量变化'}
                          </Typography>
                        </>
                      )}
                    </TableCell>
                    <TableCell align="right">
                      <Button
                        size="small"
                        color="error"
                        startIcon={<UndoOutlinedIcon />}
                        disabled={!relatedFlag || relatedFlag.status === 'rolled-back'}
                        onClick={() => {
                          setSelectedFlagId(event.flagId)
                          setReason('生产异常触发人工回滚，停止继续放量。')
                        }}
                      >
                        回滚
                      </Button>
                    </TableCell>
                  </TableRow>
                )
              })}
              {!isLoading && events.length === 0 && (
                <TableRow><TableCell colSpan={6} align="center" sx={{ py: 6 }} color="text.secondary">没有符合条件的审计记录</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </Card>

      <Dialog open={Boolean(selectedFlag)} onClose={() => setSelectedFlagId('')} fullWidth maxWidth="sm">
        <DialogTitle>回滚 {selectedFlag?.name}</DialogTitle>
        <DialogContent dividers>
          <Alert severity="error" sx={{ mb: 2 }}>回滚会关闭生产开关、停止灰度并写入审计日志。</Alert>
          <TextField
            label="回滚原因"
            multiline
            minRows={3}
            fullWidth
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSelectedFlagId('')}>取消</Button>
          <Button variant="contained" color="error" loading={rollbackState.isLoading} onClick={() => void submitRollback()}>
            确认回滚
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
