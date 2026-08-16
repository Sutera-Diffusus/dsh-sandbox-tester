/**
 * lib/registry.js — 沙盒注册表 + 共享常量(M0 core)。
 *
 * 契约(CONTRACT §3/§4):
 * - 本文件是「共享常量」的唯一权威源:6 个常量在此定义并导出,
 *   其它模块(ports/proctree/index/M1/M2)通过 `import` 引用,导出名必须与 CONTRACT §3 一致。
 *   因 §1 目录树与 §2 归属表均未列出 lib/constants.js,故常量并入 registry.js
 *   (CONTRACT §3 明确允许「并入 lib/index.js 或 registry.js」)。
 * - 注册表文档形态:{ sandboxes: { [name]: 沙盒记录 } },落盘于 REGISTRY_PATH。
 * - 沙盒记录形态(CONTRACT §4):
 *   { name, programDir, home, port, pid, createdAt, lastRunAt, status,
 *     lastReport: null | report.json 对象 }
 * - saveRegistry 原子写:先写 tmp 再 rename,避免中途崩溃留下半截 JSON。
 *
 * 本模块无第三方依赖,只依赖 node 内置;不会循环依赖(index.js → registry.js,
 * ports.js → registry.js,单向)。
 *
 * @module dsh-sandbox/registry
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

// ── 共享常量(CONTRACT §3,导出名不可改)──────────────────────────────────────
/** 沙盒根目录(sandbox_create 的产物落点)。 */
export const SANDBOX_ROOT = 'D:\\DeepseekHarness_Sandboxes'
/** 沙盒注册表文件路径(策略红线允许写入的临时数据区 D:\ai-temp)。 */
export const REGISTRY_PATH = 'D:\\ai-temp\\dsh-sandbox-registry.json'
/** 端口池起点(3080 本体 / 3181 固定桥接副本,永不占用)。 */
export const PORT_START = 3182
/** 只读复制源(本体程序目录,sandbox_create 的克隆来源)。 */
export const BODY_PROGRAM_SRC = 'D:\\Deepseek harness'
/** 超龄清理阈值(小时):超过该时长的孤儿沙盒默认标记为待清理。 */
export const AGE_HOURS = 48
/** merge 备份根(与守卫回滚源同根、分目录)。 */
export const GUARD_BACKUP_ROOT = 'D:\\DeepseekHarness_Backup'

/** 空注册表(loadRegistry 的兜底返回值)。 */
const EMPTY_REGISTRY = { sandboxes: {} }

/**
 * 读取注册表。文件不存在或损坏时返回空注册表 { sandboxes: {} }。
 * @returns {Promise<{ sandboxes: Record<string, object> }>}
 */
export async function loadRegistry() {
  let text
  try {
    text = await readFile(REGISTRY_PATH, 'utf8')
  } catch {
    return { sandboxes: {} }
  }
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return { sandboxes: {} }
  }
  const sandboxes =
    data && typeof data === 'object' && !Array.isArray(data) &&
    data.sandboxes && typeof data.sandboxes === 'object' && !Array.isArray(data.sandboxes)
      ? data.sandboxes
      : {}
  return { sandboxes }
}

/**
 * 原子写注册表:先写同目录 tmp 文件,再 rename 覆盖目标,
 * 保证任何时刻读取者都不会看到半截 JSON。
 * @param {object} reg - 形如 { sandboxes: {...} } 的注册表文档。
 * @returns {Promise<object>} 规范化后的注册表文档。
 */
export async function saveRegistry(reg) {
  const doc =
    reg && typeof reg === 'object' && reg.sandboxes && typeof reg.sandboxes === 'object' && !Array.isArray(reg.sandboxes)
      ? reg
      : { sandboxes: {} }
  const dir = dirname(REGISTRY_PATH)
  await mkdir(dir, { recursive: true })
  const tmp = `${REGISTRY_PATH}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8')
  await rename(tmp, REGISTRY_PATH)
  return doc
}

/**
 * 取一个沙盒记录;不存在返回 null。
 * @param {object} reg - 注册表文档。
 * @param {string} name - 沙盒名。
 * @returns {object | null}
 */
export function getSandbox(reg, name) {
  if (!reg || typeof reg.sandboxes !== 'object' || reg.sandboxes === null || Array.isArray(reg.sandboxes)) return null
  const record = reg.sandboxes[name]
  return record && typeof record === 'object' ? record : null
}

/**
 * 就地更新沙盒记录的 lastRunAt(ISO 时间),供 48h 超龄判断;不落盘(由调用方 saveRegistry)。
 * @param {object} reg - 注册表文档。
 * @param {string} name - 沙盒名。
 * @returns {object | null} 更新后的沙盒记录;不存在返回 null。
 */
export function touchLastRun(reg, name) {
  const record = getSandbox(reg, name)
  if (!record) return null
  record.lastRunAt = new Date().toISOString()
  return record
}
