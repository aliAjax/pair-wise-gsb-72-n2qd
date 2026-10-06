import type {
  AudienceRule,
  Environment,
  FeatureFlag,
  FlagImpact,
  ImpactSnapshot,
  EnvironmentImpact,
} from '@/types'

/**
 * 统一影响人口径引擎
 *
 * 三个页面（概览 / 审计 / 发布报告）都必须通过本引擎取数：
 * - 用确定性的分层虚拟人群 + 受众规则求值 + 稳定哈希放量，估算每个开关的毛覆盖；
 * - 同一用户被多个开关命中时，去重后的总人数只算一次；
 * - 按开关创建顺序做边际归属（早上线的开关先认领用户），每个开关的边际人数
 *   求和恰好等于去重总人数，因此不会出现重复计数。
 */

const ENVIRONMENTS: Environment[] = ['dev', 'staging', 'production']

/** 各环境真实用户基数，用于把抽样结果线性放大 */
const ENV_POPULATION: Record<Environment, number> = {
  dev: 12_000,
  staging: 320_000,
  production: 4_800_000,
}

/** 每个环境抽取的虚拟用户数，抽样是确定性的，重开读回同一套数字 */
const SAMPLE_SIZE = 2400

type Version = [number, number, number]

interface VirtualUser {
  id: string
  environment: Environment
  region: string
  platform: string
  tier: string
  segment: string
  accountType: string
  role: string
  riskScore: number
  version: Version
}

const pickWeighted = <T>(rng: () => number, entries: Array<[T, number]>): T => {
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0)
  let cursor = rng() * total
  for (const [value, weight] of entries) {
    cursor -= weight
    if (cursor <= 0) return value
  }
  return entries[0][0]
}

/** 确定性 PRNG（mulberry32），同一环境同一索引永远生成同一批用户 */
const mulberry32 = (seed: number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const VERSIONS: Array<[Version, number]> = [
  [[8, 16, 4], 6],
  [[8, 17, 2], 8],
  [[8, 18, 1], 14],
  [[9, 0, 5], 8],
  [[9, 1, 3], 14],
  [[9, 2, 0], 34],
  [[10, 0, 2], 12],
  [[10, 1, 0], 4],
]

const REGIONS: Array<[string, number]> = [
  ['CN-EAST', 38],
  ['CN-NORTH', 22],
  ['CN-SOUTH', 26],
  ['CN-WEST', 10],
  ['APAC', 4],
]

const PLATFORMS: Array<[string, number]> = [
  ['ios', 30],
  ['android', 58],
  ['web', 12],
]

const TIERS: Array<[string, number]> = [
  ['gold', 8],
  ['platinum', 4],
  ['silver', 28],
  ['free', 60],
]

const SEGMENTS: Array<[string, number]> = [
  ['active', 45],
  ['high_intent', 15],
  ['dormant', 30],
  ['new', 10],
]

const ACCOUNT_TYPES: Array<[string, number]> = [
  ['enterprise', 18],
  ['personal', 82],
]

const ROLES: Array<[string, number]> = [
  ['campaign_admin', 3],
  ['operator', 12],
  ['viewer', 85],
]

const envSeed: Record<Environment, number> = {
  dev: 0xd0e07,
  staging: 0x57a61e,
  production: 0xd06f00d,
}

const buildPopulation = (environment: Environment): VirtualUser[] => {
  const rng = mulberry32(envSeed[environment])
  return Array.from({ length: SAMPLE_SIZE }, (_, index) => ({
    id: `${environment}-${index}`,
    environment,
    region: pickWeighted(rng, REGIONS),
    platform: pickWeighted(rng, PLATFORMS),
    tier: pickWeighted(rng, TIERS),
    segment: pickWeighted(rng, SEGMENTS),
    accountType: pickWeighted(rng, ACCOUNT_TYPES),
    role: pickWeighted(rng, ROLES),
    riskScore: Math.floor(rng() * 101),
    version: pickWeighted(rng, VERSIONS),
  }))
}

const POPULATIONS: Record<Environment, VirtualUser[]> = {
  dev: buildPopulation('dev'),
  staging: buildPopulation('staging'),
  production: buildPopulation('production'),
}

const VERSION_ATTRIBUTES = new Set(['app.version', 'client.version'])

const parseVersion = (raw: string): Version => {
  const parts = raw.trim().split('.').map((part) => Number.parseInt(part, 10))
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0]
}

const compareVersion = (a: Version, b: Version) => {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return 0
}

const readAttribute = (user: VirtualUser, attribute: string): string | number => {
  switch (attribute) {
    case 'app.version':
    case 'client.version':
      return user.version.join('.')
    case 'client.platform':
      return user.platform
    case 'user.tier':
      return user.tier
    case 'user.segment':
      return user.segment
    case 'account.type':
      return user.accountType
    case 'account.risk_score':
      return user.riskScore
    case 'operator.role':
      return user.role
    case 'user.region':
      return user.region
    default:
      return ''
  }
}

const evaluateRule = (rule: AudienceRule, user: VirtualUser): boolean => {
  const raw = readAttribute(user, rule.attribute)
  let matched = false
  if ((rule.operator === 'gte' || rule.operator === 'lte') && VERSION_ATTRIBUTES.has(rule.attribute)) {
    const actual = parseVersion(String(raw))
    const target = parseVersion(rule.value)
    const order = compareVersion(actual, target)
    matched = rule.operator === 'gte' ? order >= 0 : order <= 0
  } else if (rule.operator === 'gte' || rule.operator === 'lte') {
    const actual = Number.parseFloat(String(raw))
    const target = Number.parseFloat(rule.value)
    if (Number.isNaN(actual) || Number.isNaN(target)) {
      matched = false
    } else {
      matched = rule.operator === 'gte' ? actual >= target : actual <= target
    }
  } else {
    const actual = String(raw)
    switch (rule.operator) {
      case 'equals':
        matched = actual === rule.value
        break
      case 'not-equals':
        matched = actual !== rule.value
        break
      case 'contains':
        matched = actual.includes(rule.value)
        break
      case 'in':
        matched = rule.value
          .split(',')
          .map((item) => item.trim())
          .includes(actual)
        break
      default:
        matched = false
    }
  }
  return rule.negate ? !matched : matched
}

/** 放量判定使用稳定哈希，比例变化前后同一用户的去/留确定，保证重算结果稳定 */
const isInRollout = (flagId: string, userId: string, percentage: number): boolean => {
  const key = `${flagId}::${userId}`
  let hash = 2166136261
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0) % 10_000 < percentage * 100
}

/** 开关仍在放量：启用、未回滚、灰度大于 0；冻结继续覆盖现有用户 */
export const isServing = (flag: FeatureFlag): boolean =>
  flag.enabled && flag.status !== 'rolled-back' && flag.rolloutPercentage > 0

const coversUser = (flag: FeatureFlag, user: VirtualUser): boolean => {
  if (!isServing(flag) || flag.environment !== user.environment) return false
  if (!flag.regions.includes(user.region)) return false
  if (compareVersion(user.version, parseVersion(flag.minClientVersion[user.environment])) < 0) return false
  if (!flag.audienceRules.every((rule) => evaluateRule(rule, user))) return false
  return isInRollout(flag.id, user.id, flag.rolloutPercentage)
}

/** 最大余数法取整，保证各分量取整后求和与总量取整一致 */
const apportion = (counts: number[], scale: number): number[] => {
  if (counts.length === 0) return []
  const scaled = counts.map((count) => count * scale)
  const floored = scaled.map((value) => Math.floor(value))
  let remainder = Math.round(scaled.reduce((sum, value) => sum + value, 0)) - floored.reduce((sum, value) => sum + value, 0)
  const order = scaled
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction)
  for (const { index } of order) {
    if (remainder <= 0) break
    floored[index] += 1
    remainder -= 1
  }
  return floored
}

const impactKey = (flag: FeatureFlag) =>
  JSON.stringify({
    id: flag.id,
    e: flag.environment,
    on: flag.enabled,
    s: flag.status,
    p: flag.rolloutPercentage,
    r: flag.regions,
    v: flag.minClientVersion,
    a: flag.audienceRules.map((rule) => [rule.attribute, rule.operator, rule.value, rule.negate]),
  })

const hashConfig = (text: string): string => {
  let hash = 5381
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 33) ^ text.charCodeAt(i)
  }
  return (hash >>> 0).toString(36)
}

/**
 * 计算全量去重影响快照。纯函数：同一份开关列表永远得到同一套数字。
 */
export const computeImpact = (flags: FeatureFlag[]): ImpactSnapshot => {
  // 边际归属顺序：早上线的开关先认领用户，保证多开关覆盖同一批人时每人只归属一次
  const serving = flags.filter(isServing).sort((a, b) => {
    const order = a.createdAt.localeCompare(b.createdAt)
    return order !== 0 ? order : a.id.localeCompare(b.id)
  })
  const orderIndex = new Map(serving.map((flag, index) => [flag.id, index]))

  const gross = new Map<string, number>()
  const marginal = new Map<string, number>()
  const pairOverlap = new Map<string, number>()
  let grossUsers = 0
  let totalUsers = 0
  let overlapUsers = 0

  const environments: EnvironmentImpact[] = ENVIRONMENTS.map((environment) => {
    const envServing = serving.filter((flag) => flag.environment === environment)
    const envIds = envServing.map((flag) => flag.id)
    const envGross = new Map<string, number>()
    const envMarginal = new Map<string, number>()
    const envPairs = new Map<string, number>()
    let envGrossCount = 0
    let envUnionCount = 0
    let envOverlapCount = 0

    for (const user of POPULATIONS[environment]) {
      const covered: string[] = []
      for (const flag of envServing) {
        if (coversUser(flag, user)) covered.push(flag.id)
      }
      if (covered.length === 0) continue
      envGrossCount += covered.length
      envUnionCount += 1
      if (covered.length >= 2) envOverlapCount += 1
      for (const id of covered) envGross.set(id, (envGross.get(id) ?? 0) + 1)
      for (let i = 0; i < covered.length; i += 1) {
        for (let j = i + 1; j < covered.length; j += 1) {
          const pair = [covered[i], covered[j]].sort().join('|')
          envPairs.set(pair, (envPairs.get(pair) ?? 0) + 1)
        }
      }
      // 按创建顺序最早的覆盖开关认领该用户
      const ownerId = covered.reduce((earliest, id) =>
        (orderIndex.get(id) ?? Number.MAX_SAFE_INTEGER) < (orderIndex.get(earliest) ?? Number.MAX_SAFE_INTEGER)
          ? id
          : earliest,
      )
      envMarginal.set(ownerId, (envMarginal.get(ownerId) ?? 0) + 1)
    }

    const scale = ENV_POPULATION[environment] / SAMPLE_SIZE
    const apportionedGross = apportion(envIds.map((id) => envGross.get(id) ?? 0), scale)
    const apportionedMarginal = apportion(envIds.map((id) => envMarginal.get(id) ?? 0), scale)
    envIds.forEach((id, index) => {
      gross.set(id, (gross.get(id) ?? 0) + apportionedGross[index])
      marginal.set(id, (marginal.get(id) ?? 0) + apportionedMarginal[index])
    })
    envPairs.forEach((count, pair) => {
      pairOverlap.set(pair, (pairOverlap.get(pair) ?? 0) + Math.round(count * scale))
    })
    const envGrossUsers = apportionedGross.reduce((sum, value) => sum + value, 0)
    const envUnionUsers = Math.round(envUnionCount * scale)
    grossUsers += envGrossUsers
    totalUsers += envUnionUsers
    overlapUsers += Math.round(envOverlapCount * scale)
    return {
      environment,
      grossUsers: envGrossUsers,
      unionUsers: envUnionUsers,
      marginalUsers: envUnionUsers,
      overlapUsers: Math.round(envOverlapCount * scale),
    }
  })

  const flagImpacts: FlagImpact[] = flags
    .map((flag) => {
      const overlaps = [...pairOverlap.entries()]
        .filter(([pair]) => pair.split('|').includes(flag.id))
        .map(([pair, users]) => {
          const otherId = pair.split('|').find((id) => id !== flag.id) ?? ''
          const other = flags.find((item) => item.id === otherId)
          return { flagId: otherId, flagKey: other?.key ?? otherId, users }
        })
        .filter((item) => item.users > 0)
        .sort((a, b) => b.users - a.users || a.flagId.localeCompare(b.flagId))
      const sharedUsers = overlaps.reduce((sum, item) => sum + item.users, 0)
      return {
        flagId: flag.id,
        flagKey: flag.key,
        grossUsers: gross.get(flag.id) ?? 0,
        marginalUsers: marginal.get(flag.id) ?? 0,
        sharedUsers,
        overlapUsers: sharedUsers,
        overlaps,
      }
    })
    .sort((a, b) => b.marginalUsers - a.marginalUsers || a.flagId.localeCompare(b.flagId))

  const configHash = hashConfig(flags.slice().sort((a, b) => a.id.localeCompare(b.id)).map(impactKey).join('||'))

  return {
    flags: flagImpacts,
    environments,
    grossUsers,
    totalUsers,
    overlapUsers,
    servingFlags: serving.length,
    configHash,
    computedAt: new Date().toISOString(),
  }
}

export interface ImpactDelta {
  before: ImpactSnapshot
  after: ImpactSnapshot
  /** 本开关毛覆盖（变更后） */
  grossUsers: number
  /** 去重总人数净变化，放量为正、收缩/回滚为负 */
  deltaUsers: number
  /** 回滚/收缩时释放的去重人数 */
  releasedUsers: number
  /** 变更后去重总人数 */
  totalUsers: number
}

/**
 * 以一份「变更前」开关列表为基线，应用对单个开关的覆盖状态改写，
 * 分别重算变更前后快照并给出净变化。任一开关灰度一变就调用它重算合计。
 */
export const computeImpactDelta = (
  flagsBefore: FeatureFlag[],
  flagId: string,
  patch: Partial<Pick<FeatureFlag, 'enabled' | 'rolloutPercentage' | 'status'>>,
): ImpactDelta => {
  const before = computeImpact(flagsBefore)
  const flagsAfter = flagsBefore.map((flag) =>
    flag.id === flagId
      ? {
          ...flag,
          ...patch,
        }
      : flag,
  )
  const after = computeImpact(flagsAfter)
  const deltaUsers = after.totalUsers - before.totalUsers
  const flagAfter = after.flags.find((item) => item.flagId === flagId)
  return {
    before,
    after,
    grossUsers: flagAfter?.grossUsers ?? 0,
    deltaUsers,
    releasedUsers: Math.max(0, -deltaUsers),
    totalUsers: after.totalUsers,
  }
}
