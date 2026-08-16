/**
 * lib/tools-lifecycle.js — dsh-sandbox 生命周期工具(M1)
 *
 * 拥有者:agent-lifecycle(CONTRACT §2)。本文件只实现六个生命周期原生工具:
 *   sandbox_list / sandbox_create / sandbox_inject / sandbox_stop /
 *   sandbox_destroy / sandbox_prune
 *
 * 依赖(M0 提供,本模块只 import、不修改):
 *   ./registry.js  : loadRegistry / saveRegistry / getSandbox / touchLastRun
 *   ./ports.js     : allocatePort
 *   ./proctree.js  : stopSandbox / sandboxAlive
 *   ./registry.js  : SANDBOX_ROOT / PORT_START / BODY_PROGRAM_SRC / AGE_HOURS
 *   (注:契约 CONTRACT §3 允许常量并入 registry.js;本目录无 lib/constants.js,集成阶段已把
 *     import 从 ./constants.js 收敛为 ./registry.js,与 M0 实际导出对齐)
 *
 * 安全边界(RULES.md 政策红线):
 *   - 只写 SANDBOX_ROOT(沙盒产物)+ 注册表(经 saveRegistry 原子写);
 *   - BODY_PROGRAM_SRC 是只读复制源,本模块绝不写入;
 *   - 绝不触碰本体进程(3080)/本体目录/本体数据;
 *   - 对外函数全部 async,复制/删除重活用异步 fs,不阻塞事件循环。
 *
 * 工具签名严格按 CONTRACT §5、DESIGN.md §3.1;导出函数形如:
 *   async function sandbox_xxx(args) => 结构化结果对象;非法输入/拒绝 => throw Error。
 */
import { join, resolve, relative, sep, isAbsolute, dirname } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rm, readFile, writeFile, readdir, copyFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'

import { loadRegistry, saveRegistry, getSandbox, touchLastRun } from './registry.js'
import { allocatePort } from './ports.js'
import { stopSandbox, sandboxAlive } from './proctree.js'
import { SANDBOX_ROOT, PORT_START, BODY_PROGRAM_SRC, AGE_HOURS } from './registry.js'

// touchLastRun 属于 registry 公开 API 面,供 M2(sandbox_run)更新 lastRunAt;
// 生命周期工具自身不推进"最近运行时间",故此处仅声明依赖面不调用。
void touchLastRun

// ── 常量与工具 ───────────────────────────────────────────────────────────────

/** 沙盒名合法性:字母/数字开头,后续可含 . _ -,最长 64,禁用 Windows 保留名。 */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
])

/** 本体程序内 dsh 真实入口(相对 BODY_PROGRAM_SRC)。沙盒直接跑它,不经 bin-guard。 */
const DSH_BIN_REL = ['node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js']

const AGE_MS = AGE_HOURS * 60 * 60 * 1000

function messageOf(error, fallback = '未知错误') {
  return error instanceof Error && error.message ? error.message : String(error ?? fallback)
}

function sandboxDir(name) {
  return join(SANDBOX_ROOT, name)
}

function programDir(name) {
  return join(sandboxDir(name), 'program')
}

/**
 * 沙盒 home(即 DSH_HOME)。按 CONTRACT §7 目录产物,home 落在
 *   <sandbox>\home\.dsh\
 * 该 .dsh 目录就是传给进程的 DSH_HOME(与 CONTRACT §4 的 DSH_HOME=<meta.home> 一致)。
 */
function sandboxHome(name) {
  return join(sandboxDir(name), 'home', '.dsh')
}

function validateName(name) {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error('缺少沙盒名称(name)')
  }
  const trimmed = name.trim()
  if (!NAME_PATTERN.test(trimmed)) {
    throw new Error(`沙盒名称非法:${JSON.stringify(name)}(允许 [A-Za-z0-9._-],首字符须为字母/数字,最长 64)`)
  }
  if (RESERVED_NAMES.has(trimmed.toUpperCase())) {
    throw new Error(`沙盒名称非法:${name} 是 Windows 保留名`)
  }
  return trimmed
}

/** 读取本体 dsh 版本,作为沙盒 meta.json 的 sourceVersion。 */
function readSourceVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(BODY_PROGRAM_SRC, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * robocopy 包装:robocopy 用退出码 0-7 表示成功、>=8 表示失败;
 * execFile 对非 0 退出码会抛错,这里按 0-7 视为成功。
 */
function runRobocopy(src, dst) {
  return new Promise((resolvePromise, reject) => {
    const args = [src, dst, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1']
    execFile('robocopy', args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        if (typeof error.code === 'number' && error.code >= 0 && error.code < 8) {
          resolvePromise({ code: error.code, skippedByRobocopy: error.code >= 2 })
          return
        }
        reject(new Error(`robocopy 失败:${messageOf(error)}${String(stderr || '').slice(-400)}`))
        return
      }
      resolvePromise({ code: 0, skippedByRobocopy: false })
    })
  })
}

/**
 * 递归复制目录;单文件失败(被本体进程锁定的原生 .node/.dll 等)不中断整体,仅记录跳过。
 * 这是 DESIGN §9「复制只读源、跳过本体锁文件」的落地:沙盒复制以"尽力而为"为准。
 */
async function copyTree(src, dst, skipped) {
  await mkdir(dst, { recursive: true })
  let entries
  try {
    entries = await readdir(src, { withFileTypes: true })
  } catch (error) {
    throw new Error(`读取复制源失败 ${src}:${messageOf(error)}`)
  }
  for (const entry of entries) {
    const s = join(src, entry.name)
    const d = join(dst, entry.name)
    if (entry.isDirectory()) {
      await copyTree(s, d, skipped)
    } else if (entry.isSymbolicLink()) {
      // 本体 node_modules 当前无 reparse point,此分支仅防御;失败即跳过。
      try {
        const { readlink, symlink } = await import('node:fs/promises')
        const target = await readlink(s)
        try { await symlink(target, d, 'junction') } catch { await symlink(target, d) }
      } catch {
        skipped.push(s)
      }
    } else if (entry.isFile()) {
      try {
        await copyFile(s, d)
      } catch {
        skipped.push(s)
      }
    }
    // 其它类型(套接字/管道等)跳过
  }
}

/** 把补丁目标相对路径安全解析到 program 目录内,越界抛错。 */
function resolveWithinProgram(program, relPath) {
  if (typeof relPath !== 'string' || relPath === '') {
    throw new Error('补丁目标路径缺失')
  }
  if (isAbsolute(relPath)) {
    throw new Error(`补丁目标必须是相对 program 的路径(收到绝对路径):${relPath}`)
  }
  if (relPath.includes('\u0000')) {
    throw new Error('补丁目标路径包含非法字符(NUL)')
  }
  const resolved = resolve(program, relPath)
  const rel = relative(program, resolved)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`补丁目标越界(必须位于 ${program} 之内):${relPath}`)
  }
  return { abs: resolved, rel }
}

function formatAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '未知'
  if (ms < 60000) return '刚刚'
  if (ms < 3600000) return `${Math.round(ms / 60000)} 分钟前`
  if (ms < 86400000) return `${(ms / 3600000).toFixed(1)} 小时前`
  return `${(ms / 86400000).toFixed(1)} 天前`
}

function ageInfo(record) {
  const base = record.lastRunAt || record.createdAt || null
  if (!base) return { text: '未知', hours: null, stale: false }
  const ms = Date.now() - Date.parse(base)
  if (!Number.isFinite(ms)) return { text: '未知', hours: null, stale: false }
  const hours = ms / 3600000
  return { text: formatAge(ms), hours, stale: ms > AGE_MS }
}

/** 把 patch 参数规整为统一的操作列表 [{ path, action: 'write'|'copy'|'delete', content?, source? }]。 */
function normalizePatch(patch) {
  if (typeof patch === 'string') {
    try {
      patch = JSON.parse(patch)
    } catch {
      throw new Error('patch 无法解析为 JSON 对象')
    }
  }
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('patch 必须是对象或 JSON 字符串')
  }
  let items
  if (Array.isArray(patch.files)) {
    items = patch.files
  } else if (typeof patch.path === 'string') {
    items = [patch] // 单文件简写 { path, content } / { path, source } / { path, delete }
  } else {
    throw new Error('patch 缺少 files 数组或单文件 path 字段')
  }
  if (items.length === 0) {
    throw new Error('patch.files 为空,没有可应用的补丁项')
  }
  const out = []
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('patch.files 每项必须是对象')
    }
    if (item.delete) {
      out.push({ path: item.path, action: 'delete' })
      continue
    }
    if (item.source !== undefined) {
      if (typeof item.source !== 'string' || item.source === '') {
        throw new Error(`补丁项 source 非法:${JSON.stringify(item.path)}`)
      }
      out.push({ path: item.path, action: 'copy', source: item.source })
      continue
    }
    if (item.content === undefined || item.content === null) {
      throw new Error(`补丁项缺少 content 或 source:${JSON.stringify(item.path)}`)
    }
    if (typeof item.content !== 'string' && !Buffer.isBuffer(item.content) && !(item.content instanceof Uint8Array)) {
      throw new Error(`补丁项 content 必须是字符串或 Buffer:${JSON.stringify(item.path)}`)
    }
    out.push({ path: item.path, action: 'write', content: item.content })
  }
  return out
}

function contentBuffer(content) {
  if (typeof content === 'string') return Buffer.from(content, 'utf8')
  return Buffer.from(content)
}

// ── 工具实现 ─────────────────────────────────────────────────────────────────

/**
 * sandbox_list({})
 * 返回全部沙盒摘要:名称/状态/端口/home/年龄/lastReport 结论(含 48h 超龄标记)。
 */
export async function sandbox_list(args = {}) {
  const reg = await loadRegistry()
  const boxes = Object.values(reg.sandboxes || {})
  const summaries = boxes.map((record) => {
    const age = ageInfo(record)
    return {
      name: record.name,
      status: record.status ?? 'unknown',
      port: record.port ?? null,
      home: record.home ?? null,
      programDir: record.programDir ?? null,
      pid: record.pid ?? null,
      createdAt: record.createdAt ?? null,
      lastRunAt: record.lastRunAt ?? null,
      age: age.text,
      ageHours: age.hours === null ? null : Number(age.hours.toFixed(2)),
      stale: age.stale,
      lastReportConclusion: record.lastReport && typeof record.lastReport.conclusion === 'string'
        ? record.lastReport.conclusion
        : null,
    }
  })
  summaries.sort((a, b) => String(a.name).localeCompare(String(b.name)))
  return { ok: true, count: summaries.length, sandboxes: summaries }
}

/**
 * sandbox_create({ name?, basePort?, fullCopy? })
 * 从 BODY_PROGRAM_SRC 复制出沙盒 program,建独立 home\.dsh,分配端口,
 * 写 start-sandbox.bat 与 meta.json,注册表 status='stopped'。
 * 默认裁剪:只复制 node_modules + 必要运行文件(package.json),天然排除
 *   backups/.npm-cache/*.exe/*.dll/WebView2 等;fullCopy=true 用 robocopy /E 全量。
 */
export async function sandbox_create(args = {}) {
  const name = validateName(args.name)
  const fullCopy = args.fullCopy === true

  const reg = await loadRegistry()
  if (getSandbox(reg, name)) {
    throw new Error(`沙盒已存在(注册表):${name}`)
  }
  if (existsSync(sandboxDir(name))) {
    throw new Error(`沙盒目录已存在:${sandboxDir(name)}`)
  }
  if (!existsSync(BODY_PROGRAM_SRC)) {
    throw new Error(`本体程序复制源不存在:${BODY_PROGRAM_SRC}(只读源,未写入)`)
  }

  const port = await allocatePort(Number.isInteger(args.basePort) && args.basePort > 0 ? args.basePort : PORT_START)

  try {
    // 目录:program + home\.dsh
    await mkdir(programDir(name), { recursive: true })
    await mkdir(sandboxHome(name), { recursive: true })

    // 复制 program
    const skipped = []
    if (fullCopy) {
      await runRobocopy(BODY_PROGRAM_SRC, programDir(name))
    } else {
      await copyTree(join(BODY_PROGRAM_SRC, 'node_modules'), join(programDir(name), 'node_modules'), skipped)
      const srcPkg = join(BODY_PROGRAM_SRC, 'package.json')
      if (existsSync(srcPkg)) {
        try {
          await copyFile(srcPkg, join(programDir(name), 'package.json'))
        } catch {
          skipped.push(srcPkg)
        }
      }
    }

    // 入口自检:复制完成后确认 bin.js 存在,否则该沙盒无法启动。
    const binJs = join(programDir(name), ...DSH_BIN_REL)
    if (!existsSync(binJs)) {
      throw new Error(`沙盒缺少 dsh 入口(bin.js):${binJs};复制可能不完整`)
    }

    const home = sandboxHome(name)
    const program = programDir(name)
    const createdAt = new Date().toISOString()
    const sourceVersion = readSourceVersion()

    const meta = { name, port, createdAt, sourceVersion, programDir: program, home }
    await writeFile(join(sandboxDir(name), 'meta.json'), JSON.stringify(meta, null, 2) + '\n')

    const batLines = [
      '@echo off',
      'chcp 65001 >nul',
      `set "DSH_HOME=${home}"`,
      `set "DSH_INSTALL_DIR=${program}"`,
      `node "${binJs}" web --port ${port}`,
      '',
    ]
    await writeFile(join(sandboxDir(name), 'start-sandbox.bat'), batLines.join('\r\n'))

    const record = {
      name,
      programDir: program,
      home,
      port,
      pid: null,
      createdAt,
      lastRunAt: null,
      status: 'stopped',
      lastReport: null,
    }
    reg.sandboxes[name] = record
    await saveRegistry(reg)

    return {
      ok: true,
      name,
      status: 'stopped',
      port,
      home,
      programDir: program,
      copyMode: fullCopy ? 'full' : 'trim',
      sourceVersion,
      startBat: join(sandboxDir(name), 'start-sandbox.bat'),
      metaPath: join(sandboxDir(name), 'meta.json'),
      skippedLockedFiles: skipped.length,
    }
  } catch (error) {
    // 失败回滚:清理半成品沙盒目录,避免留下孤儿。
    try {
      await rm(sandboxDir(name), { recursive: true, force: true })
    } catch {}
    throw new Error(`sandbox_create 失败(已回滚半成品目录):${messageOf(error)}`)
  }
}

/**
 * sandbox_inject({ name, patch })
 * 把补丁应用到沙盒 program 内:先备份到 <sandbox>\.inject-backups\<ts>\ 并写回滚清单 json;
 * 严格校验每个目标路径必须位于 SANDBOX_ROOT\<name>\program\ 之内,越界抛错。
 *
 * patch 形态(对象或 JSON 字符串):
 *   { files: [ { path, content } | { path, source } | { path, delete: true } ] }
 *   或单文件简写 { path, content } / { path, source } / { path, delete: true }
 */
export async function sandbox_inject(args = {}) {
  const name = validateName(args.name)
  const reg = await loadRegistry()
  const record = getSandbox(reg, name)
  if (!record) {
    throw new Error(`沙盒不存在:${name}`)
  }
  const program = programDir(name)
  if (!existsSync(program)) {
    throw new Error(`沙盒 program 目录不存在:${program}`)
  }

  const files = normalizePatch(args.patch)

  // 备份目录时间戳(文件名安全,无冒号/点)
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const backupRoot = join(sandboxDir(name), '.inject-backups', ts)
  await mkdir(backupRoot, { recursive: true })

  const manifest = {
    sandbox: name,
    at: new Date().toISOString(),
    backupRoot: relative(sandboxDir(name), backupRoot).split(sep).join('/') || '.',
    entries: [],
  }

  const applied = []
  for (const entry of files) {
    const { abs, rel } = resolveWithinProgram(program, entry.path)
    const relSlash = rel.split(sep).join('/')

    // 1) 备份原文件(若存在)
    const existedBefore = existsSync(abs)
    let backupRel = null
    if (existedBefore) {
      const backupAbs = join(backupRoot, ...rel.split(sep))
      await mkdir(dirname(backupAbs), { recursive: true })
      try {
        await copyFile(abs, backupAbs)
        backupRel = relSlash
      } catch (error) {
        throw new Error(`备份原文件失败 ${entry.path}:${messageOf(error)}`)
      }
    }

    // 2) 应用补丁
    if (entry.action === 'write') {
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, contentBuffer(entry.content))
    } else if (entry.action === 'copy') {
      const srcAbs = resolve(entry.source)
      if (!existsSync(srcAbs)) {
        throw new Error(`补丁源文件不存在:${srcAbs}`)
      }
      let buf
      try {
        buf = await readFile(srcAbs)
      } catch (error) {
        throw new Error(`读取补丁源失败 ${srcAbs}:${messageOf(error)}`)
      }
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, buf)
    } else {
      await rm(abs, { force: true })
    }

    manifest.entries.push({ path: relSlash, action: entry.action, existedBefore, backup: backupRel })
    applied.push({ path: relSlash, action: entry.action, existedBefore, backup: backupRel })
  }

  const manifestPath = join(backupRoot, 'manifest.json')
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

  return {
    ok: true,
    name,
    applied,
    backupDir: backupRoot,
    manifestPath,
    note: '回滚清单已写入 manifest.json;回滚=按 entries 逐条:existedBefore=true 时从 backup 恢复,false 时删除目标文件。',
  }
}

/**
 * sandbox_stop({ name })
 * 停止沙盒进程树(仅沙盒 PID 树,stopSandbox 内部校验不含 3080 本体 PID),置 status='stopped'。
 */
export async function sandbox_stop(args = {}) {
  const name = validateName(args.name)
  const reg = await loadRegistry()
  const record = getSandbox(reg, name)
  if (!record) {
    throw new Error(`沙盒不存在:${name}`)
  }
  if (record.pid == null && record.status !== 'running') {
    return { ok: true, name, status: record.status ?? 'stopped', pid: null, note: '沙盒未在运行' }
  }
  await stopSandbox(record)
  record.status = 'stopped'
  record.pid = null
  await saveRegistry(reg)
  return { ok: true, name, status: 'stopped', pid: null }
}

/**
 * sandbox_destroy({ name, confirm })
 * confirm!==true 拒绝;先 stopSandbox 再删 SANDBOX_ROOT\<name> 整目录与注册表项。
 */
export async function sandbox_destroy(args = {}) {
  const name = validateName(args.name)
  if (args.confirm !== true) {
    throw new Error(`sandbox_destroy 需要显式确认:confirm 必须为 true(收到 ${JSON.stringify(args.confirm)}),拒绝销毁 ${name}`)
  }
  const reg = await loadRegistry()
  const record = getSandbox(reg, name)
  if (!record) {
    throw new Error(`沙盒不存在:${name}`)
  }
  if (record.pid != null || record.status === 'running') {
    try {
      await stopSandbox(record)
    } catch (error) {
      // 若 stopSandbox 触发 3080 保护抛错,绝不继续删除,防止误伤本体。
      throw new Error(`销毁前停止沙盒失败,已中止:${messageOf(error)}`)
    }
  }
  await rm(sandboxDir(name), { recursive: true, force: true })
  delete reg.sandboxes[name]
  await saveRegistry(reg)
  return { ok: true, name, removed: true }
}

/**
 * sandbox_prune({ dryRun? })
 * 清理孤儿沙盒:status!=='running' 且(超龄 AGE_HOURS 或 进程已死)→ 删除。
 * 判定细化(避免误删刚创建、从未运行的沙盒):
 *   - 超龄:lastRunAt(缺省回退 createdAt)距今 > AGE_HOURS;
 *   - 已死:曾记录过进程/运行(pid!=null 或 lastRunAt!=null)但 sandboxAlive 为 false。
 * dryRun=true 只列出候选,不做删除;删除前若仍有进程则先 stopSandbox。
 */
export async function sandbox_prune(args = {}) {
  const dryRun = args.dryRun === true
  const reg = await loadRegistry()
  const now = Date.now()

  const candidates = []
  for (const record of Object.values(reg.sandboxes || {})) {
    if (record.status === 'running') continue // 运行中绝不触碰

    const base = record.lastRunAt || record.createdAt || null
    const baseMs = base ? Date.parse(base) : NaN
    const aged = Number.isFinite(baseMs) && now - baseMs > AGE_MS

    let dead = false
    if (!aged && (record.pid != null || record.lastRunAt != null)) {
      try {
        dead = !(await sandboxAlive(record))
      } catch {
        dead = false // 探测失败按不处理,避免误删
      }
    }

    if (aged || dead) {
      candidates.push({ name: record.name, reason: aged ? 'aged' : 'dead', status: record.status, pid: record.pid ?? null })
    }
  }

  if (dryRun) {
    return { ok: true, dryRun: true, candidates, removed: [] }
  }

  const removed = []
  const errors = []
  for (const candidate of candidates) {
    const record = getSandbox(reg, candidate.name)
    if (!record) continue
    try {
      if (record.pid != null) {
        await stopSandbox(record)
      }
      await rm(sandboxDir(candidate.name), { recursive: true, force: true })
      delete reg.sandboxes[candidate.name]
      removed.push(candidate.name)
    } catch (error) {
      errors.push({ name: candidate.name, error: messageOf(error) })
    }
  }
  await saveRegistry(reg)

  return {
    ok: errors.length === 0,
    dryRun: false,
    candidates,
    removed,
    errors,
  }
}

/** 供 M0 便捷汇总导入的工具表(函数引用,不含 defineTool 注册)。 */
export default {
  sandbox_list,
  sandbox_create,
  sandbox_inject,
  sandbox_stop,
  sandbox_destroy,
  sandbox_prune,
}
