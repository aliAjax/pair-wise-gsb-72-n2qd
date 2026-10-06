/**
 * 可重试的本地持久化层
 *
 * 写入采用「备份上一份完整记录 → 写主记录 → 读回校验」的提交流程：
 * - 任一步失败都从上一份完整记录重试，绝不在半成品上叠加修改；
 * - 达到重试上限后回滚主记录为上一份完整记录并抛出异常，调用方据此提示失败；
 * - 读取时主记录损坏则自动降级到备份，两者都不可用才由调用方重建种子。
 */

export interface KVStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

const MAX_WRITE_ATTEMPTS = 3

export const createBrowserStorage = (): KVStorage => {
  const memory = new Map<string, string>()
  const resolve = (): Storage | null => {
    try {
      if (typeof window !== 'undefined' && window.localStorage) return window.localStorage
    } catch {
      /* localStorage 被禁用时退化为内存存储 */
    }
    return null
  }
  return {
    getItem(key) {
      try {
        return resolve()?.getItem(key) ?? memory.get(key) ?? null
      } catch {
        return memory.get(key) ?? null
      }
    },
    setItem(key, value) {
      try {
        resolve()?.setItem(key, value)
      } catch {
        /* 配额或隐私模式失败时仅保留内存副本 */
      }
      memory.set(key, value)
    },
  }
}

const cloneRecord = (raw: string): string => {
  // 反序列化再序列化，确认拿到的是结构完整的 JSON 记录
  return JSON.stringify(JSON.parse(raw))
}

const isValidJson = (raw: string): boolean => {
  try {
    cloneRecord(raw)
    return true
  } catch {
    return false
  }
}

export interface CommitResult {
  attempts: number
  restoredFromBackup: boolean
}

export const commitRecord = (
  primaryKey: string,
  backupKey: string,
  payload: unknown,
  storage: KVStorage,
): CommitResult => {
  const serialized = JSON.stringify(payload)
  // 上一份完整记录：优先主记录，主记录坏了用备份
  const previous = (() => {
    const primary = storage.getItem(primaryKey)
    if (primary !== null && isValidJson(primary)) return primary
    const backup = storage.getItem(backupKey)
    if (backup !== null && isValidJson(backup)) return backup
    return null
  })()

  let lastError: unknown = null
  for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
    try {
      if (previous !== null) storage.setItem(backupKey, previous)
      storage.setItem(primaryKey, serialized)
      const readBack = storage.getItem(primaryKey)
      if (readBack !== null && isValidJson(readBack) && cloneRecord(readBack) === cloneRecord(serialized)) {
        return { attempts: attempt, restoredFromBackup: false }
      }
      lastError = new Error('写入后读回的记录与提交内容不一致')
    } catch (error) {
      lastError = error
    }
    // 入库失败：下一轮从上一份完整记录重新走完整提交流程
  }

  // 所有重试均失败，主记录恢复为上一份完整记录，避免留下半成品
  if (previous !== null) {
    try {
      storage.setItem(primaryKey, previous)
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(
    `数据入库连续 ${MAX_WRITE_ATTEMPTS} 次失败，已恢复至上一份完整记录：${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  )
}

/** 读取并校验主记录，损坏时回退到备份；都不可用返回 null */
export const readVerifiedRecord = <T>(
  primaryKey: string,
  backupKey: string,
  storage: KVStorage,
): T | null => {
  const primary = storage.getItem(primaryKey)
  if (primary !== null && isValidJson(primary)) return JSON.parse(primary) as T
  const backup = storage.getItem(backupKey)
  if (backup !== null && isValidJson(backup)) return JSON.parse(backup) as T
  return null
}
