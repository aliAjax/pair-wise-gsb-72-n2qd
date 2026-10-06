import { useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
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
import AssessmentOutlinedIcon from '@mui/icons-material/AssessmentOutlined'
import { useGetAuditQuery, useGetDashboardQuery, useGetFlagsQuery, useGetImpactQuery, useGetIssuesQuery } from '@/services/flagApi'
import type { Environment } from '@/types'
import { FlagStatusChip } from '@/components/FlagStatusChip'

const escapeCsv = (value: string | number) => `"${String(value).replace(/"/g, '""')}"`

export function ReportsPage() {
  const [environment, setEnvironment] = useState('')
  const [message, setMessage] = useState('')
  const { data: flags = [], isLoading } = useGetFlagsQuery({})
  const { data: dashboard } = useGetDashboardQuery()
  const { data: issues = [] } = useGetIssuesQuery({})
  const { data: audit = [] } = useGetAuditQuery({})
  // 与概览、审计共用的统一去重口径快照；切换环境按同一引擎重算
  const { data: impact } = useGetImpactQuery((environment || '') as '' | Environment)

  const impactById = useMemo(
    () => new Map((impact?.flags ?? []).map((item) => [item.flagId, item])),
    [impact],
  )

  const reportFlags = useMemo(
    () => flags.filter((flag) => !environment || flag.environment === environment),
    [environment, flags],
  )

  const reportGross = reportFlags.reduce(
    (sum, flag) => sum + (impactById.get(flag.id)?.grossUsers ?? 0),
    0,
  )
  const reportMarginal = reportFlags.reduce(
    (sum, flag) => sum + (impactById.get(flag.id)?.marginalUsers ?? 0),
    0,
  )

  const overlapPairs = useMemo(
    () =>
      (impact?.flags ?? [])
        .flatMap((item) =>
          item.overlaps.map((overlap) => ({
            left: item.flagKey,
            right: overlap.flagKey,
            users: overlap.users,
          })),
        )
        .filter((pair, index, list) => {
          const signature = [pair.left, pair.right].sort().join('|')
          return (
            list.findIndex((other) => [other.left, other.right].sort().join('|') === signature) ===
            index
          )
        })
        .sort((a, b) => b.users - a.users)
        .slice(0, 6),
    [impact],
  )

  const exportReport = () => {
    const rows = [
      [
        '开关Key',
        '名称',
        '环境',
        '状态',
        '灰度比例',
        '负责人',
        '团队',
        '受众规则',
        '依赖数',
        '监控指标',
        '回滚条件',
        '毛覆盖用户（含重叠）',
        '去重边际用户（合计口径）',
        '与其他开关重叠用户',
        '重叠开关',
      ],
      ...reportFlags.map((flag) => {
        const stat = impactById.get(flag.id)
        return [
          flag.key,
          flag.name,
          flag.environment,
          flag.status,
          `${flag.rolloutPercentage}%`,
          flag.owner,
          flag.team,
          flag.audienceRules.length,
          flag.dependencies.length,
          flag.metricNames.join('|'),
          flag.rollbackConditions.join('|'),
          stat?.grossUsers ?? 0,
          stat?.marginalUsers ?? 0,
          stat?.overlapUsers ?? 0,
          (stat?.overlaps ?? []).map((item) => `${item.flagKey}:${item.users}`).join('|'),
        ]
      }),
      [
        '合计',
        '',
        environment || '全部环境',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        '',
        reportGross,
        reportMarginal,
        reportGross - reportMarginal,
        '',
      ],
    ]
    const csv = `\uFEFF${rows.map((row) => row.map(escapeCsv).join(',')).join('\n')}`
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `feature-flag-release-report-${new Date().toISOString().slice(0, 10)}.csv`
    anchor.click()
    URL.revokeObjectURL(url)
    setMessage('发布报告已按去重边际口径导出')
  }

  const riskFlags = reportFlags.filter((flag) => {
    const flagIssues = issues.filter((issue) => issue.flagId === flag.id && !issue.resolved)
    return flagIssues.some((issue) => issue.severity === 'blocker')
  })

  return (
    <Box>
      <Box className="page-heading">
        <Box>
          <Typography variant="h2">发布报告</Typography>
          <Typography color="text.secondary">
            汇总开关配置、影响评审问题、灰度状态与审计轨迹，导出可归档的发布报告。
          </Typography>
        </Box>
        <Stack direction="row" spacing={1}>
          <TextField select label="环境范围" value={environment} onChange={(event) => setEnvironment(event.target.value)} sx={{ width: 160 }}>
            <MenuItem value="">全部环境</MenuItem>
            <MenuItem value="dev">开发</MenuItem>
            <MenuItem value="staging">预发</MenuItem>
            <MenuItem value="production">生产</MenuItem>
          </TextField>
          <Button variant="contained" startIcon={<DownloadOutlinedIcon />} onClick={exportReport}>
            导出 CSV
          </Button>
        </Stack>
      </Box>

      {message && <Alert severity="success" onClose={() => setMessage('')} sx={{ mb: 2 }}>{message}</Alert>}
      {isLoading && <LinearProgress sx={{ mb: 2 }} />}

      <Box className="report-summary">
        <Box className="report-summary-main">
          <AssessmentOutlinedIcon />
          <Box>
            <Typography variant="caption">报告范围</Typography>
            <Typography className="summary-value">{reportFlags.length} 个开关</Typography>
          </Box>
        </Box>
        <Box><Typography variant="caption">生产已启用</Typography><Typography className="summary-value">{reportFlags.filter((flag) => flag.enabled).length}</Typography></Box>
        <Box><Typography variant="caption">未解决阻断项</Typography><Typography className="summary-value danger">{riskFlags.length}</Typography></Box>
        <Box><Typography variant="caption">审计事件</Typography><Typography className="summary-value">{audit.length}</Typography></Box>
        <Box>
          <Typography variant="caption">影响用户（去重边际）</Typography>
          <Typography className="summary-value">{reportMarginal.toLocaleString()}</Typography>
        </Box>
        <Box>
          <Typography variant="caption">简单求和（含重复计数）</Typography>
          <Typography className="summary-value" sx={{ color: reportGross > reportMarginal ? 'warning.main' : undefined }}>
            {reportGross.toLocaleString()}
          </Typography>
        </Box>
      </Box>

      <Alert severity={(impact?.overlapUsers ?? 0) > 0 ? 'info' : 'success'} sx={{ mb: 2 }}>
        {environment ? `${environment === 'production' ? '生产' : environment === 'staging' ? '预发' : '开发'}环境` : '全部环境'}下，
        毛覆盖简单求和 {reportGross.toLocaleString()} 人，去重后边际合计 {reportMarginal.toLocaleString()} 人，
        同一用户被多个开关命中只计一次；合计数字与概览、审计记录同源。
      </Alert>

      <Box className="report-grid">
        <Card>
          <CardContent>
            <Typography variant="h3" sx={{ mb: 2 }}>各环境去重影响</Typography>
            {(impact?.environments ?? dashboard?.environments ?? []).map((item) => (
              <Box key={item.environment} className="report-bar-row">
                <Box className="report-bar-copy">
                  <Typography variant="body2" fontWeight={700}>
                    {item.environment === 'production' ? '生产' : item.environment === 'staging' ? '预发' : '开发'}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    去重 {item.unionUsers.toLocaleString()} 人 · 简单求和 {item.grossUsers.toLocaleString()} 人
                    {item.overlapUsers > 0 ? ` · 重叠 ${item.overlapUsers.toLocaleString()} 人` : ''}
                  </Typography>
                </Box>
                <Box className="report-bar-track">
                  <Box
                    className="report-bar-fill"
                    sx={{
                      width: `${
                        impact && impact.grossUsers > 0
                          ? Math.max(6, (item.unionUsers / Math.max(...impact.environments.map((env) => env.unionUsers))) * 100)
                          : 0
                      }%`,
                    }}
                  />
                </Box>
              </Box>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <Typography variant="h3" sx={{ mb: 2 }}>开关重叠人群 Top 6</Typography>
            {overlapPairs.length === 0 && (
              <Typography variant="body2" color="text.secondary">当前在放量开关之间没有检测到人群重叠。</Typography>
            )}
            {overlapPairs.map((pair) => (
              <Box key={`${pair.left}-${pair.right}`} className="report-bar-row">
                <Box className="report-bar-copy">
                  <Typography variant="body2" fontWeight={700}>{pair.left}</Typography>
                  <Typography variant="caption" color="text.secondary">与 {pair.right} 共同命中</Typography>
                </Box>
                <Chip size="small" color="warning" variant="outlined" label={`${pair.users.toLocaleString()} 人（只计一次）`} />
              </Box>
            ))}
            <Box className="issue-distribution" sx={{ mt: 2 }}>
              {(['blocker', 'warning', 'info'] as const).map((severity) => {
                const count = issues.filter((issue) => issue.severity === severity && !issue.resolved).length
                return (
                  <Box key={severity}>
                    <Chip color={severity === 'blocker' ? 'error' : severity === 'warning' ? 'warning' : 'default'} size="small" label={severity === 'blocker' ? '阻断' : severity === 'warning' ? '警告' : '提示'} />
                    <Typography className="summary-value">{count}</Typography>
                    <Typography variant="caption" color="text.secondary">未解决</Typography>
                  </Box>
                )
              })}
            </Box>
          </CardContent>
        </Card>
      </Box>

      <Card>
        <CardContent>
          <Typography variant="h3" sx={{ mb: 1.5 }}>发布明细（去重边际口径）</Typography>
          <TableContainer>
            <Table>
              <TableHead>
                <TableRow>
                  <TableCell>功能开关</TableCell>
                  <TableCell>环境 / 状态</TableCell>
                  <TableCell>灰度</TableCell>
                  <TableCell>毛覆盖（含重叠）</TableCell>
                  <TableCell>去重边际（计入合计）</TableCell>
                  <TableCell>重叠开关</TableCell>
                  <TableCell>最后变更</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {reportFlags.map((flag) => {
                  const stat = impactById.get(flag.id)
                  return (
                    <TableRow key={flag.id} hover>
                      <TableCell>
                        <Typography variant="body2" fontWeight={700}>{flag.name}</Typography>
                        <Typography variant="caption" color="text.secondary">{flag.key}</Typography>
                      </TableCell>
                      <TableCell>
                        <Chip size="small" variant="outlined" label={flag.environment.toUpperCase()} />
                        <Box sx={{ mt: 0.5 }}><FlagStatusChip status={flag.status} /></Box>
                      </TableCell>
                      <TableCell>{flag.rolloutPercentage}%</TableCell>
                      <TableCell>{(stat?.grossUsers ?? 0).toLocaleString()}</TableCell>
                      <TableCell>
                        <Typography fontWeight={700}>{(stat?.marginalUsers ?? 0).toLocaleString()}</Typography>
                        {(stat?.overlapUsers ?? 0) > 0 && (
                          <Typography variant="caption" color="warning.main">
                            其中 {(stat?.overlapUsers ?? 0).toLocaleString()} 人与其他开关重叠
                          </Typography>
                        )}
                      </TableCell>
                      <TableCell>
                        {(stat?.overlaps ?? []).length === 0 ? (
                          <Typography variant="caption" color="text.secondary">无</Typography>
                        ) : (
                          <Stack spacing={0.5}>
                            {stat?.overlaps.slice(0, 3).map((overlap) => (
                              <Chip
                                key={overlap.flagId}
                                size="small"
                                variant="outlined"
                                label={`${overlap.flagKey} · ${(overlap.users ?? 0).toLocaleString()}`}
                              />
                            ))}
                          </Stack>
                        )}
                      </TableCell>
                      <TableCell>
                        <Typography variant="body2">{flag.lastChangedBy}</Typography>
                        <Typography variant="caption" color="text.secondary">{flag.updatedAt.slice(0, 16).replace('T', ' ')}</Typography>
                      </TableCell>
                    </TableRow>
                  )
                })}
                <TableRow>
                  <TableCell colSpan={3}><Typography fontWeight={700}>合计</Typography></TableCell>
                  <TableCell><Typography fontWeight={700}>{reportGross.toLocaleString()}</Typography></TableCell>
                  <TableCell><Typography fontWeight={700} color="primary.main">{reportMarginal.toLocaleString()}</Typography></TableCell>
                  <TableCell colSpan={2}>
                    <Typography variant="caption" color="text.secondary">
                      毛覆盖与边际之差 {(reportGross - reportMarginal).toLocaleString()} 人为跨开关重复计数，概览/审计/报告统一只算一次
                    </Typography>
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </TableContainer>
        </CardContent>
      </Card>
    </Box>
  )
}
