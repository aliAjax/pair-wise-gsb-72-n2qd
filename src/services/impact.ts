import type { Environment, FeatureFlag, ImpactReport } from '@/types'

/**
 * 统一影响人数口径。
 *
 * 概览、审计记录、发布报告必须共用同一份计算结果：
 * - 多个开关覆盖同一批用户时，按去重后的边际口径只计一次；
 * - 任一开关灰度变化后，用最新开关数据重新执行本模块即可得到新合计；
 * - 计算只依赖开关 key、灰度比例、环境与生效状态，不含随机因素，
 *   同一份数据无论何时重算、重开页面读回，都是同一套数字。
 *
 * 模型：为每个环境准备一个固定的虚拟用户样本池，用确定性哈希把
 * 「开关 key × 用户」映射到分桶，模拟灰度命中，再按环境用户总量放大。
 */

/** 各环境可寻址用户总量（估算基准） */
const AUDIENCE_UNIVERSE: Record<Environment, number> = {
  production: 4_860_000,
  staging: 96_000,
  dev: 24_000,
}

/** 虚拟用户样本池大小与分桶数 */
const SAMPLE_SIZE = 20_000
const BUCKET_COUNT = 10_000

const ENVIRONMENTS: Environment[] = ['production', 'staging', 'dev']

/** cyrb53 哈希：同一 (开关 key, 用户) 组合永远落入同一个桶，保证口径可复算 */
const cyrb53 = (value: string, seed = 0): number => {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let index = 0; index < value.length; index += 1) {
    const char = value.charCodeAt(index)
    h1 = Math.imul(h1 ^ char, 2654435761)
    h2 = Math.imul(h2 ^ char, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

/** 生效口径：开关已启用且灰度大于 0（冻结开关的现有用户继续命中，仍计入） */
export const isEffective = (flag: FeatureFlag): boolean =>
  flag.enabled && flag.rolloutPercentage > 0

const scale = (hits: number, environment: Environment): number =>
  Math.round((hits / SAMPLE_SIZE) * AUDIENCE_UNIVERSE[environment])

export const computeImpact = (flags: FeatureFlag[]): ImpactReport => {
  const perFlag: ImpactReport['flags'] = []
  let totalUsers = 0
  let grossUsers = 0
  let overlapUsers = 0

  for (const environment of ENVIRONMENTS) {
    const effective = flags.filter(
      (flag) => flag.environment === environment && isEffective(flag),
    )
    if (effective.length === 0) continue

    // 每个样本用户被几个开关命中；仅被唯一开关命中时记录该开关下标
    const hitCounts = new Uint16Array(SAMPLE_SIZE)
    const soleFlag = new Int32Array(SAMPLE_SIZE).fill(-1)
    const flagHits = new Array<number>(effective.length).fill(0)

    for (let user = 0; user < SAMPLE_SIZE; user += 1) {
      for (let index = 0; index < effective.length; index += 1) {
        const flag = effective[index]
        const bucket = cyrb53(`${flag.key}#${user}`) % BUCKET_COUNT
        if (bucket < (flag.rolloutPercentage / 100) * BUCKET_COUNT) {
          flagHits[index] += 1
          hitCounts[user] += 1
          soleFlag[user] = hitCounts[user] === 1 ? index : -2
        }
      }
    }

    let unionHits = 0
    let overlapHits = 0
    const marginalHits = new Array<number>(effective.length).fill(0)
    for (let user = 0; user < SAMPLE_SIZE; user += 1) {
      if (hitCounts[user] > 0) unionHits += 1
      if (hitCounts[user] > 1) overlapHits += 1
      if (soleFlag[user] >= 0) marginalHits[soleFlag[user]] += 1
    }

    totalUsers += scale(unionHits, environment)
    overlapUsers += scale(overlapHits, environment)
    effective.forEach((flag, index) => {
      const coveredUsers = scale(flagHits[index], environment)
      grossUsers += coveredUsers
      perFlag.push({
        flagId: flag.id,
        flagKey: flag.key,
        flagName: flag.name,
        environment,
        rolloutPercentage: flag.rolloutPercentage,
        coveredUsers,
        marginalUsers: scale(marginalHits[index], environment),
      })
    })
  }

  return { totalUsers, grossUsers, overlapUsers, flags: perFlag }
}

/**
 * 单个开关当前的去重边际影响：仅被该开关覆盖、去掉它合计就会减少的人数。
 * 注意：存在 100% 全量开关时，其他开关的边际可能为 0（其人群已被全覆盖）。
 */
export const computeMarginalUsers = (flags: FeatureFlag[], flagId: string): number =>
  computeImpact(flags).flags.find((item) => item.flagId === flagId)?.marginalUsers ?? 0

/**
 * 单个开关的独立覆盖人数（不与其他开关去重）。
 * 审计事件与回滚释放人数使用此口径：回滚前先算清该开关当前覆盖的人数，
 * 再清零灰度，即为本次释放的影响范围。
 */
export const computeCoveredUsers = (flags: FeatureFlag[], flagId: string): number =>
  computeImpact(flags).flags.find((item) => item.flagId === flagId)?.coveredUsers ?? 0
