import type {
  AuditEvent,
  DashboardData,
  Environment,
  FeatureFlag,
  ImpactIssue,
  ImpactSnapshot,
  ReviewPayload,
} from '@/types'
import { computeImpact, computeImpactDelta, isServing } from '@/services/impactEngine'
import { seedFlags, seedIssues } from '@/services/seeds'
import { commitRecord, createBrowserStorage, readVerifiedRecord, type KVStorage } from '@/services/storage'

const STORAGE_KEY = 'feature-flag-release-console-v1'
const BACKUP_KEY = 'feature-flag-release-console-v1-backup'
const DB_VERSION = 2

export interface Database {
  version: number
  flags: FeatureFlag[]
  audit: AuditEvent[]
  issues: ImpactIssue[]
  /** 最近一次统一口径影响快照，概览/审计/报告共用 */
  impact: ImpactSnapshot
}

/** 便于测试注入：Node 脚本可替换为故障存储 */
export let storageAdapter: KVStorage = createBrowserStorage()
export const setStorageAdapter = (adapter: KVStorage) => {
  storageAdapter = adapter
}

export const newAuditId = () =>
  `audit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

/**
 * 种子审计记录：每条记录的人数都用统一引擎按「变更前 vs 变更后」去重重算，
 * 与当前开关拓扑、概览和报告是同一套口径，而不是各自拍脑袋的基数。
 */
const buildSeedAudit = (flags: FeatureFlag[]): AuditEvent[] => {
  const patch = (
    list: FeatureFlag[],
    id: string,
    change: Partial<FeatureFlag>,
  ): FeatureFlag[] => list.map((flag) => (flag.id === id ? { ...flag, ...change } : flag))

  const delta = (
    listBefore: FeatureFlag[],
    id: string,
    change: Partial<FeatureFlag>,
  ) => {
    const result = computeImpactDelta(listBefore, id, change)
    const flag = listBefore.find((item) => item.id === id)
    return {
      grossUsers: result.grossUsers,
      affectedUsers: Math.abs(result.deltaUsers),
      deltaUsers: result.deltaUsers,
      releasedUsers: result.releasedUsers > 0 ? result.releasedUsers : undefined,
      key: flag?.key ?? '',
    }
  }

  // audit-1：极速支付 5% -> 20%（变更前为未放量，用关闭态模拟 5% 的更低基线）
  const base101 = patch(flags, 'flag-101', { enabled: false, rolloutPercentage: 0 })
  const d1 = delta(patch(base101, 'flag-101', { enabled: true, rolloutPercentage: 5 }), 'flag-101', {
    enabled: true,
    rolloutPercentage: 20,
    status: 'active',
  })

  // audit-2：实时特征冻结，覆盖不变化，记录冻结时的去重边际覆盖
  const frozen105 = computeImpact(flags).flags.find((item) => item.flagId === 'flag-105')
  const d2Gross = frozen105?.grossUsers ?? 0
  const d2Marginal = frozen105?.marginalUsers ?? 0

  // audit-3：活动编辑器 20% -> 0 回滚，先算释放人数
  const base106 = patch(flags, 'flag-106', {
    status: 'active',
    enabled: true,
    rolloutPercentage: 20,
  })
  const d3 = delta(base106, 'flag-106', { status: 'rolled-back', enabled: false, rolloutPercentage: 0 })

  // audit-4：智能推荐 20% -> 35%，在全量开关（支付路由）覆盖范围内，净新增为 0
  const base102 = patch(flags, 'flag-102', { enabled: true, rolloutPercentage: 20 })
  const d4 = delta(base102, 'flag-102', { rolloutPercentage: 35 })

  // audit-6：支付聚合路由评审通过（0 -> 100%）
  const base104 = patch(flags, 'flag-104', { status: 'review', enabled: false, rolloutPercentage: 0 })
  const d6 = delta(base104, 'flag-104', { status: 'active', enabled: true, rolloutPercentage: 100 })

  return [
    {
      id: 'audit-1',
      flagId: 'flag-101',
      flagKey: 'checkout.express-pay-v2',
      action: 'rollout-adjusted',
      actor: '陈思远',
      summary: '灰度比例由 5% 调整至 20%，仅覆盖 iOS 金卡及铂金用户。',
      before: '5%',
      after: '20%',
      grossUsers: d1.grossUsers,
      deltaUsers: d1.deltaUsers,
      affectedUsers: d1.affectedUsers,
      createdAt: '2026-09-29T09:05:00+08:00',
    },
    {
      id: 'audit-2',
      flagId: 'flag-105',
      flagKey: 'feature.realtime-profile',
      action: 'frozen',
      actor: '郭宁',
      summary: 'P99 延迟升高，冻结配置并暂停扩大流量，现有覆盖人群维持不变。',
      before: 'active',
      after: 'frozen',
      grossUsers: d2Gross,
      deltaUsers: 0,
      affectedUsers: d2Marginal,
      createdAt: '2026-09-29T08:50:00+08:00',
    },
    {
      id: 'audit-3',
      flagId: 'flag-106',
      flagKey: 'campaign.new-editor',
      action: 'rolled-back',
      actor: '梁琪',
      summary: '配置保存失败率触发自动回滚条件，释放全部灰度人群并清零。',
      before: '20%',
      after: '0%',
      grossUsers: d3.grossUsers,
      deltaUsers: d3.deltaUsers,
      affectedUsers: d3.affectedUsers,
      releasedUsers: d3.releasedUsers,
      createdAt: '2026-09-28T15:48:00+08:00',
    },
    {
      id: 'audit-4',
      flagId: 'flag-102',
      flagKey: 'catalog.smart-recommendation',
      action: 'rollout-adjusted',
      actor: '周启',
      summary: '灰度扩大到 35%，新增命中人群已被支付聚合路由覆盖，去重后净新增为 0。',
      before: '20%',
      after: '35%',
      grossUsers: d4.grossUsers,
      deltaUsers: d4.deltaUsers,
      affectedUsers: d4.affectedUsers,
      createdAt: '2026-09-28T16:40:00+08:00',
    },
    {
      id: 'audit-5',
      flagId: 'flag-103',
      flagKey: 'console.billing-export-v3',
      action: 'submitted',
      actor: '周航',
      summary: '提交发布评审，等待补齐导出完成率监控，开关尚未放量。',
      before: 'draft',
      after: 'draft',
      grossUsers: 0,
      deltaUsers: 0,
      affectedUsers: 0,
      createdAt: '2026-09-28T18:20:00+08:00',
    },
    {
      id: 'audit-6',
      flagId: 'flag-104',
      flagKey: 'payment.aggregate-router',
      action: 'approved',
      actor: '林默',
      summary: '确认回滚条件和支付通道指标完整，批准后按去重边际口径纳入影响合计。',
      before: 'review',
      after: 'active',
      grossUsers: d6.grossUsers,
      deltaUsers: d6.deltaUsers,
      affectedUsers: d6.affectedUsers,
      createdAt: '2026-09-25T12:30:00+08:00',
    },
  ]
}

const withImpact = (flags: FeatureFlag[], audit: AuditEvent[], issues: ImpactIssue[]): Database => ({
  version: DB_VERSION,
  flags,
  audit,
  issues,
  impact: computeImpact(flags),
})

export const seedDatabase = (): Database =>
  withImpact(structuredClone(seedFlags), buildSeedAudit(structuredClone(seedFlags)), structuredClone(seedIssues))

/** 读数据库：主记录损坏自动回退备份；都不可用则重建种子（种子本身也是一份完整记录） */
export const readDatabase = (): Database => {
  const record = readVerifiedRecord<Database>(STORAGE_KEY, BACKUP_KEY, storageAdapter)
  if (record && record.version === DB_VERSION && Array.isArray(record.flags)) {
    // 快照配置指纹过期（例如外部直接改了存储）时重开读回自动重算同一套数字
    if (!record.impact || record.impact.configHash !== computeImpact(record.flags).configHash) {
      const refreshed = { ...record, impact: computeImpact(record.flags) }
      persist(refreshed)
      return refreshed
    }
    return record
  }
  const seed = seedDatabase()
  persist(seed)
  return seed
}

const persist = (database: Database): Database => {
  const next: Database = { ...database, version: DB_VERSION, impact: computeImpact(database.flags) }
  commitRecord(STORAGE_KEY, BACKUP_KEY, next, storageAdapter)
  return next
}

/**
 * 所有写入共用的事务入口：
 * 从最近一份完整记录开始修改，提交失败时由存储层基于该记录重试/回滚，
 * 因此调用方拿到异常时可以直接重新调用，会从同一份完整记录重放。
 */
const mutateDatabase = (mutator: (db: Database) => { db: Database; event?: AuditEvent }): {
  db: Database
  event?: AuditEvent
} => {
  const base = readDatabase()
  const working = structuredClone(base)
  const { db, event } = mutator(working)
  const committed = persist(db)
  return { db: committed, event }
}

export const saveFlag = (flag: FeatureFlag): { flag: FeatureFlag; event: AuditEvent; impact: ImpactSnapshot } => {
  const result = mutateDatabase((db) => {
    const index = db.flags.findIndex((item) => item.id === flag.id)
    const timestamp = new Date().toISOString()
    const next: FeatureFlag = { ...flag, updatedAt: timestamp }
    let event: AuditEvent

    if (index >= 0) {
      const before = db.flags[index]
      const coverageChanged =
        before.enabled !== next.enabled ||
        before.rolloutPercentage !== next.rolloutPercentage ||
        before.status !== next.status ||
        JSON.stringify(before.regions) !== JSON.stringify(next.regions) ||
        JSON.stringify(before.audienceRules) !== JSON.stringify(next.audienceRules)
      // 先用变更前的开关拓扑算清净影响，再落库，保证人数口径一致
      const delta = coverageChanged
        ? computeImpactDelta(db.flags, next.id, {
            enabled: next.enabled,
            rolloutPercentage: next.rolloutPercentage,
            status: next.status,
          })
        : null
      db.flags[index] = next
      event = {
        id: newAuditId(),
        flagId: next.id,
        flagKey: next.key,
        action:
          before.rolloutPercentage !== next.rolloutPercentage || before.enabled !== next.enabled
            ? 'rollout-adjusted'
            : 'updated',
        actor: next.lastChangedBy,
        summary:
          before.rolloutPercentage !== next.rolloutPercentage
            ? `灰度比例由 ${before.rolloutPercentage}% 调整至 ${next.rolloutPercentage}%，按去重边际口径重算合计。`
            : '更新开关受众、依赖、版本或回滚条件。',
        before: `${before.status} / ${before.rolloutPercentage}%`,
        after: `${next.status} / ${next.rolloutPercentage}%`,
        grossUsers: delta?.grossUsers ?? 0,
        deltaUsers: delta?.deltaUsers ?? 0,
        affectedUsers: Math.abs(delta?.deltaUsers ?? 0),
        createdAt: timestamp,
      }
    } else {
      db.flags.unshift(next)
      event = {
        id: newAuditId(),
        flagId: next.id,
        flagKey: next.key,
        action: 'created',
        actor: next.lastChangedBy,
        summary: '创建功能开关草稿，尚未放量。',
        after: next.status,
        grossUsers: 0,
        deltaUsers: 0,
        affectedUsers: 0,
        createdAt: timestamp,
      }
    }

    db.audit.unshift(event)
    return { db, event }
  })
  const saved = result.db.flags.find((item) => item.id === flag.id)
  if (!saved) throw new Error('开关保存后读回失败')
  return { flag: saved, event: result.event!, impact: result.db.impact }
}

export const submitForReview = (flagId: string, actor: string): FeatureFlag => {
  const { db } = mutateDatabase((current) => {
    const target = current.flags.find((item) => item.id === flagId)
    if (!target) throw new Error('功能开关不存在')
    const timestamp = new Date().toISOString()
    target.status = 'review'
    target.updatedAt = timestamp
    target.lastChangedBy = actor
    current.audit.unshift({
      id: newAuditId(),
      flagId,
      flagKey: target.key,
      action: 'submitted',
      actor,
      summary: '提交发布影响评审，放量状态保持不变。',
      before: 'draft',
      after: 'review',
      grossUsers: current.impact.flags.find((item) => item.flagId === flagId)?.grossUsers ?? 0,
      deltaUsers: 0,
      affectedUsers: 0,
      createdAt: timestamp,
    })
    return { db: current }
  })
  const saved = db.flags.find((item) => item.id === flagId)
  if (!saved) throw new Error('提交后读回失败')
  return saved
}

export const applyReview = (flagId: string, payload: ReviewPayload): FeatureFlag => {
  const { db } = mutateDatabase((current) => {
    const target = current.flags.find((item) => item.id === flagId)
    if (!target) throw new Error('功能开关不存在')
    const timestamp = new Date().toISOString()
    const beforeStatus = target.status

    if (payload.decision === 'approved') {
      // 先按变更前拓扑算清净影响，再更新状态
      const delta = computeImpactDelta(current.flags, flagId, {
        enabled: true,
        status: 'active',
      })
      target.status = 'active'
      target.enabled = true
      target.updatedAt = timestamp
      target.lastChangedBy = payload.reviewer
      if (payload.freezeUntil) {
        target.rollbackConditions.push(`冻结至 ${payload.freezeUntil}，期间禁止扩大流量`)
      }
      current.audit.unshift({
        id: newAuditId(),
        flagId,
        flagKey: target.key,
        action: 'approved',
        actor: payload.reviewer,
        summary: payload.comment,
        before: beforeStatus,
        after: 'active',
        grossUsers: delta.grossUsers,
        deltaUsers: delta.deltaUsers,
        affectedUsers: Math.abs(delta.deltaUsers),
        createdAt: timestamp,
      })
    } else {
      target.status = 'draft'
      target.enabled = false
      target.updatedAt = timestamp
      target.lastChangedBy = payload.reviewer
      current.audit.unshift({
        id: newAuditId(),
        flagId,
        flagKey: target.key,
        action: 'rejected',
        actor: payload.reviewer,
        summary: payload.comment,
        before: beforeStatus,
        after: 'draft',
        grossUsers: 0,
        deltaUsers: 0,
        affectedUsers: 0,
        createdAt: timestamp,
      })
    }
    return { db: current }
  })
  const saved = db.flags.find((item) => item.id === flagId)
  if (!saved) throw new Error('审批后读回失败')
  return saved
}

export const rollbackFlag = (flagId: string, actor: string, reason: string): {
  flag: FeatureFlag
  event: AuditEvent
  impact: ImpactSnapshot
} => {
  const result = mutateDatabase((current) => {
    const target = current.flags.find((item) => item.id === flagId)
    if (!target) throw new Error('功能开关不存在')

    // 第一步：在任何清零动作之前，先按当前（变更前）拓扑算清释放的去重人数
    const release = computeImpactDelta(current.flags, flagId, {
      enabled: false,
      rolloutPercentage: 0,
      status: 'rolled-back',
    })
    const timestamp = new Date().toISOString()
    const before = `${target.status} / ${target.rolloutPercentage}%`

    // 第二步：清零并关闭开关
    target.status = 'rolled-back'
    target.enabled = false
    target.rolloutPercentage = 0
    target.updatedAt = timestamp
    target.lastChangedBy = actor
    target.rolloutSteps.forEach((step) => {
      if (step.status === 'running') step.status = 'paused'
    })

    // 第三步：把释放人数写进审计记录（人数在清零之前已确定）
    const event: AuditEvent = {
      id: newAuditId(),
      flagId,
      flagKey: target.key,
      action: 'rolled-back',
      actor,
      summary: `${reason} 清零前核定释放 ${release.releasedUsers.toLocaleString()} 名去重用户。`,
      before,
      after: 'rolled-back / 0%',
      grossUsers: release.grossUsers,
      deltaUsers: release.deltaUsers,
      affectedUsers: release.releasedUsers,
      releasedUsers: release.releasedUsers,
      createdAt: timestamp,
    }
    current.audit.unshift(event)
    return { db: current, event }
  })
  const saved = result.db.flags.find((item) => item.id === flagId)
  if (!saved) throw new Error('回滚后读回失败')
  return { flag: saved, event: result.event!, impact: result.db.impact }
}

export const getImpactSnapshot = (environment?: Environment | ''): ImpactSnapshot => {
  const db = readDatabase()
  if (!environment) return db.impact
  const flags = db.flags.filter((flag) => flag.environment === environment)
  return computeImpact(flags)
}

export const getDashboardStats = (): DashboardData => {
  const db = readDatabase()
  return {
    activeFlags: db.flags.filter((flag) => flag.enabled).length,
    pendingReview: db.flags.filter((flag) => flag.status === 'review').length,
    blockerIssues: db.issues.filter((issue) => issue.severity === 'blocker' && !issue.resolved).length,
    affectedUsers: db.impact.totalUsers,
    grossUsers: db.impact.grossUsers,
    overlapUsers: db.impact.overlapUsers,
    servingFlags: db.impact.servingFlags,
    environments: db.impact.environments,
    environmentDiff: db.flags
      .filter((flag) => isServing(flag) || flag.status === 'frozen' || flag.status === 'review')
      .map((flag) => ({
        flag: flag.name,
        environment: flag.environment,
        dev: flag.environment === 'dev' ? flag.rolloutPercentage : 0,
        staging: flag.environment === 'staging' ? flag.rolloutPercentage : 0,
        production: flag.environment === 'production' ? flag.rolloutPercentage : 0,
      })),
    adoptionTrend: [
      { date: '09-23', flags: 18, rollbacks: 1 },
      { date: '09-24', flags: 21, rollbacks: 0 },
      { date: '09-25', flags: 19, rollbacks: 2 },
      { date: '09-26', flags: 24, rollbacks: 1 },
      { date: '09-27', flags: 27, rollbacks: 0 },
      { date: '09-28', flags: 31, rollbacks: 3 },
      { date: '09-29', flags: 29, rollbacks: 1 },
    ],
  }
}
