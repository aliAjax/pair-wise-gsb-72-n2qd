export type FlagStatus = 'draft' | 'review' | 'active' | 'frozen' | 'rolled-back'
export type Environment = 'dev' | 'staging' | 'production'
export type RuleOperator = 'equals' | 'not-equals' | 'contains' | 'in' | 'gte' | 'lte'
export type IssueSeverity = 'blocker' | 'warning' | 'info'
export type IssueCategory =
  | 'rule-conflict'
  | 'dead-code'
  | 'missing-metric'
  | 'overlap'
  | 'client-compatibility'

export interface AudienceRule {
  id: string
  attribute: string
  operator: RuleOperator
  value: string
  negate: boolean
}

export interface RolloutStep {
  id: string
  percentage: number
  audience: string
  startedAt: string
  status: 'completed' | 'running' | 'planned' | 'paused'
  guardrails: string[]
}

export interface Dependency {
  flagId: string
  type: 'requires' | 'conflicts' | 'fallback'
  condition: string
}

export interface FeatureFlag {
  id: string
  key: string
  name: string
  description: string
  owner: string
  team: string
  status: FlagStatus
  environment: Environment
  enabled: boolean
  rolloutPercentage: number
  audienceRules: AudienceRule[]
  regions: string[]
  minClientVersion: Record<Environment, string>
  dependencies: Dependency[]
  rollbackConditions: string[]
  metricNames: string[]
  deadCodeStatus: 'clean' | 'candidate' | 'confirmed'
  rolloutSteps: RolloutStep[]
  createdAt: string
  updatedAt: string
  lastChangedBy: string
}

/** 单个开关在统一去重口径下的人群口径 */
export interface FlagImpact {
  flagId: string
  flagKey: string
  /** 独立按本开关规则估算的毛覆盖人数（含与其他开关重叠的部分） */
  grossUsers: number
  /** 去重后归属本开关的边际人数：所有开关边际之和恰好等于去重总人数 */
  marginalUsers: number
  /** 与其他在放量开关共同覆盖的重叠人数（对称口径） */
  sharedUsers: number
  /** 至少与一个其他在放量开关共同覆盖的人数 */
  overlapUsers: number
  /** 重叠明细，按重叠人数降序 */
  overlaps: Array<{ flagId: string; flagKey: string; users: number }>
}

/** 单环境的人群覆盖口径 */
export interface EnvironmentImpact {
  environment: Environment
  grossUsers: number
  unionUsers: number
  marginalUsers: number
  overlapUsers: number
}

/** 全量（跨环境去重）影响快照，概览/审计/报告共用同一套数字 */
export interface ImpactSnapshot {
  /** 各开关去重边际口径，marginalUsers 求和等于 totalUsers */
  flags: FlagImpact[]
  environments: EnvironmentImpact[]
  /** 简单求和口径（会重复计数），用于对照展示重复计数的水分 */
  grossUsers: number
  /** 去重后实际受影响总人数 */
  totalUsers: number
  /** 被两个及以上开关同时覆盖的去重人数 */
  overlapUsers: number
  /** 参与计算的在放量开关数量 */
  servingFlags: number
  configHash: string
  computedAt: string
}

export interface AuditEvent {
  id: string
  flagId: string
  flagKey: string
  action:
    | 'created'
    | 'updated'
    | 'submitted'
    | 'approved'
    | 'rejected'
    | 'frozen'
    | 'unfrozen'
    | 'rolled-back'
    | 'rollout-adjusted'
  actor: string
  summary: string
  before?: string
  after?: string
  /** 本开关独立估算的毛覆盖人数（不参与去重合计，仅作明细） */
  grossUsers?: number
  /** 本次变更对去重总人数的净变化：放量为正、收缩/回滚为负 */
  deltaUsers?: number
  /** 统一口径下的受影响人数，按去重后的边际口径计算 */
  affectedUsers: number
  /** 回滚场景：清零前算清的释放人数（与 deltaUsers 绝对值一致） */
  releasedUsers?: number
  createdAt: string
}

export interface ImpactIssue {
  id: string
  flagId: string
  flagKey: string
  category: IssueCategory
  severity: IssueSeverity
  title: string
  detail: string
  suggestion: string
  resolved: boolean
}

export interface DashboardData {
  activeFlags: number
  pendingReview: number
  blockerIssues: number
  /** 去重后的实际受影响总人数（与 ImpactSnapshot.totalUsers 一致） */
  affectedUsers: number
  /** 简单求和口径，大于 affectedUsers 的部分即重复计数水分 */
  grossUsers: number
  overlapUsers: number
  servingFlags: number
  environments: EnvironmentImpact[]
  environmentDiff: Array<{
    flag: string
    environment: Environment
    dev: number
    staging: number
    production: number
  }>
  adoptionTrend: Array<{ date: string; flags: number; rollbacks: number }>
}

export interface FlagFilter {
  keyword?: string
  status?: FlagStatus | ''
  environment?: Environment | ''
  team?: string
  owner?: string
}

export interface ReviewPayload {
  reviewer: string
  decision: 'approved' | 'rejected'
  comment: string
  freezeUntil?: string
}
