/**
 * dsh-sandbox / lib/merge-gate.js — [M2] sandbox_merge 合回门禁实现。
 *
 * 模块归属:agent-runmerge(仅拥有本文件与 lib/tools-runhealth.js,不写其它模块文件)。
 *
 * 注入契约(与 CONTRACT §4 对齐):本模块不直接 import M0 的 lib 文件,
 * 由 M0 的 lib/index.js 注入服务:
 *
 *   import { sandboxMergeTool } from './merge-gate.js'
 *   ctx.tools.register(sandboxMergeTool(services))
 *
 * services = { registry, ports, proctree, constants }(同 tools-runhealth.js 头注释)。
 *
 * 门禁序列(任一步失败即中止,绝不带着坏状态收工):
 *   ① 目标白名单:仅允许 11 个本体补丁面(CRITICAL_RELS,与
 *      D:\Deepseek harness\bin-guard.cjs 的 CRITICAL_RELS 一字不差,只读参考)
 *      + targets 显式声明的新增文件(目标在本体尚不存在)。其它任何既有本体文件一律拒绝。
 *   ② 逐文件 node --check(HTML 做结构校验)。
 *   ③ 生成备份计划(GUARD_BACKUP_ROOT\merge-<ts>\)与回滚清单(只生成,不执行)。
 *   ④ dryRun=true(默认):仅校验 + 出报告,绝不写本体;
 *      dryRun=false:必须 process.env.DSH_SANDBOX_MERGE_ALLOW === '1' 才执行真实写入,
 *      否则抛错拒绝(开发阶段禁止写本体,守卫写在代码内)。
 *
 * 政策红线(RULES.md):真实写入只在 DSH_SANDBOX_MERGE_ALLOW=1 下可能发生,
 * 且写入前先备份、失败即回滚;本模块代码自身不会在本代理开发阶段被触发写本体。
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

// ── 常量(回退值;优先取 services.constants)─────────────────────────────────────
const BODY_PROGRAM_SRC_FALLBACK = 'D:\\Deepseek harness' // 只读复制源/合回目标根(本体程序)
const GUARD_BACKUP_ROOT_FALLBACK = 'D:\\DeepseekHarness_Backup' // merge 备份根(与守卫同根,分目录)
const MERGE_ALLOW_ENV = 'DSH_SANDBOX_MERGE_ALLOW'

/**
 * 本体关键补丁面(11 个)。与 D:\Deepseek harness\bin-guard.cjs 的 CRITICAL_RELS
 * 保持一致;扩展(宿主/客户端插件)可写入的补丁目标。只读参考,禁止私自增删。
 */
const CRITICAL_RELS = [
  'node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js',
  'node_modules/@deepseek-ai/dsh-client-ui-theme/lib/index.js',
  'node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html',
  'node_modules/@deepseek-ai/dsh-client-ui-settings-general/lib/client.js',
  'node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js',
  'node_modules/@deepseek-ai/dsh-host-apiproxy/lib/index.js',
  'node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js',
  'node_modules/@deepseek-ai/dsh-user-questions/lib/index.js',
  'node_modules/@deepseek-ai/dsh-client-connection/lib/client.js',
  'node_modules/@deepseek-ai/dsh-workspace/lib/index.js',
  'node_modules/@deepseek-ai/dsh-windows-notify/lib/index.js',
]

// ── 小工具 ─────────────────────────────────────────────────────────────────────
/** CONTRACT §6 统一 report.json 形态。 */
function buildReport(sandbox, kind, checks, conclusion, excerpt = '') {
  return {
    sandbox,
    at: new Date().toISOString(),
    kind,
    checks,
    conclusion,
    excerpt,
  }
}

function timestampStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

/** 规范化本体相对路径:仅允许不含 .. 的纯相对路径(拒绝绝对路径/盘符/越界)。 */
function normalizeRel(rel) {
  if (typeof rel !== 'string' || rel.trim() === '') return null
  let r = rel.trim().replace(/\\/g, '/')
  if (/^[A-Za-z]:/.test(r)) return null // Windows 绝对(盘符)
  if (r.startsWith('/')) return null // POSIX 绝对
  r = r.replace(/^\.\//, '')
  const segments = r.split('/')
  const out = []
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') return null // 禁止路径穿越
    out.push(seg)
  }
  return out.length > 0 ? out.join('/') : null
}

/** 把规范化后的本体相对路径解析为绝对路径,并确保落在本体根目录内。 */
function bodyAbsPath(normRel, bodyRoot) {
  const root = resolve(bodyRoot)
  const abs = resolve(root, ...normRel.split('/'))
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new Error(`路径越界(超出本体根目录):${normRel}`)
  }
  return abs
}

/** 白名单判定:补丁面 / 新增文件 / 拒绝。 */
function whitelistKind(normRel, bodyAbs) {
  if (CRITICAL_RELS.includes(normRel)) {
    return { allowed: true, reason: '白名单补丁面(CRITICAL_RELS)' }
  }
  if (!existsSync(bodyAbs)) {
    return { allowed: true, reason: '新增文件(targets 显式声明)' }
  }
  return { allowed: false, reason: '既非 11 补丁面、又非新增文件,禁止覆盖既有本体文件' }
}

/**
 * 归一化 targets 为 [{ srcAbs, dst, bodyAbs }]。
 * 每项形如 { src, dst }(兼容别名 { from, to }):
 *   - src:沙盒侧源文件,绝对路径或相对 meta.programDir 的相对路径;
 *   - dst:本体侧目标,相对本体根、不含 .. 的相对路径。
 */
function normalizeTargets(targets, meta, bodyRoot, sandboxRoot) {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error('targets 必须是非空数组,每项形如 { src, dst }')
  }
  const programDir = meta && typeof meta.programDir === 'string' && meta.programDir
    ? meta.programDir
    : join(sandboxRoot, meta.name, 'program')

  const out = []
  for (const t of targets) {
    if (!t || typeof t !== 'object') throw new Error('targets 每项必须是 { src, dst } 对象')
    const src = typeof t.src === 'string' && t.src ? t.src : (typeof t.from === 'string' ? t.from : null)
    const dst = typeof t.dst === 'string' && t.dst ? t.dst : (typeof t.to === 'string' ? t.to : null)
    if (!src) throw new Error('targets 每项需提供 src(沙盒源文件路径)')
    if (!dst) throw new Error('targets 每项需提供 dst(本体相对路径)')
    const srcAbs = isAbsolute(src) ? resolve(src) : resolve(programDir, src)
    const norm = normalizeRel(dst)
    if (!norm) throw new Error(`dst 非法(必须为不含 .. 的本体相对路径):${dst}`)
    out.push({ srcAbs, dst: norm, bodyAbs: bodyAbsPath(norm, bodyRoot) })
  }
  return out
}

/** HTML 结构校验(与 bin-guard.cjs 的 index.html 处理一致)。 */
function checkHtml(file) {
  try {
    const text = readFileSync(file, 'utf8')
    const ok = text.includes('<html') && text.includes('</html>')
    return { ok, detail: ok ? 'HTML 结构校验通过(<html>…</html>)' : 'HTML 结构校验失败(缺少 <html> 或 </html>)' }
  } catch (error) {
    return { ok: false, detail: `读取失败:${error instanceof Error ? error.message : String(error)}` }
  }
}

/** node --check(异步,不阻塞宿主事件循环)。 */
function checkJs(file, signal) {
  return new Promise((resolveCheck) => {
    const child = spawn(process.execPath, ['--check', file], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
      signal,
    })
    let stderr = ''
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', (error) => resolveCheck({ ok: false, detail: `spawn 失败:${error instanceof Error ? error.message : String(error)}` }))
    child.on('close', (code) => resolveCheck({
      ok: code === 0,
      detail: code === 0 ? 'node --check 通过' : `node --check 失败:${stderr.slice(0, 300)}`,
    }))
  })
}

function isHtmlFile(p) {
  const lower = String(p).toLowerCase()
  return lower.endsWith('.html') || lower.endsWith('.htm')
}

async function checkSyntax(file, signal) {
  if (isHtmlFile(file)) return checkHtml(file)
  return checkJs(file, signal)
}

/** 生成备份计划与回滚清单(纯数据,不落盘、不执行)。 */
function planBackup(targets, backupRoot) {
  const stamp = timestampStamp()
  const backupDir = join(backupRoot, `merge-${stamp}`)
  const files = targets.map((t) => ({
    dst: t.dst,
    body: t.bodyAbs,
    src: t.srcAbs,
    backup: join(backupDir, ...t.dst.split('/')),
    isNew: !existsSync(t.bodyAbs),
  }))

  const lines = [
    `# dsh-sandbox merge 回滚清单 — 生成于 ${new Date().toISOString()}`,
    `# 备份目录:${backupDir}`,
    `# 本清单由 sandbox_merge 生成;仅在 DSH_SANDBOX_MERGE_ALLOW=1 真实写入时落盘。`,
    '',
  ]
  for (const f of files) {
    lines.push(`## ${f.dst}${f.isNew ? ' (新增)' : ''}`)
    lines.push(`apply   : copy "${f.src}" -> "${f.body}"`)
    lines.push(`rollback: ${f.isNew ? `del "${f.body}"` : `copy "${f.backup}" -> "${f.body}"`}`)
    lines.push('')
  }

  return { stamp, backupDir, files, manifest: lines.join('\n') }
}

// ── sandbox_merge ─────────────────────────────────────────────────────────────
export function sandboxMergeTool(services) {
  const registry = services && services.registry
  const constants = services && services.constants

  return defineTool({
    name: 'sandbox_merge',
    description: '门禁式把沙盒改动合回本体:目标白名单(11 补丁面 + 显式新增文件)+ 逐文件 node --check + 备份计划/回滚清单;默认 dryRun(仅校验出报告,绝不写本体)。真实写入需 DSH_SANDBOX_MERGE_ALLOW=1。',
    parameters: {
      name: { type: 'string', required: true, description: '沙盒名(解析沙盒 programDir 与报告归属)' },
      targets: {
        type: 'array',
        required: true,
        items: { type: 'object', additionalProperties: true },
        description: '合回文件清单,每项 { src: 沙盒源文件(绝对或相对 programDir), dst: 本体相对路径(如 node_modules/@deepseek-ai/.../index.js) }',
      },
      dryRun: { type: 'boolean', description: '默认 true:仅校验 + 出报告,不写本体;false 才可能真实写入(另需 DSH_SANDBOX_MERGE_ALLOW=1)' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          dryRun: { type: 'boolean', required: true },
          applied: { type: 'boolean' },
          appliedFiles: { type: 'array', items: { type: 'string' } },
          backupDir: { type: 'string' },
          report: { type: 'object', additionalProperties: true },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `合回门禁 ${value.ok ? '通过' : '未通过'}${value.dryRun ? '(dryRun,未写本体)' : (value.applied ? '(已真实写入)' : '')}`
          + (value.backupDir ? `\n备份计划:${value.backupDir}` : '')
          + (value.message ? `\n${value.message}` : ''),
      }],
    },
    timeoutMs: 300000,
    async execute(args, exec) {
      if (!registry) {
        throw new Error('sandbox_merge: 缺少 M0 注入的 services(registry),请检查插件接线')
      }
      const bodyRoot = (constants && typeof constants.BODY_PROGRAM_SRC === 'string' && constants.BODY_PROGRAM_SRC)
        || BODY_PROGRAM_SRC_FALLBACK
      const backupRoot = (constants && typeof constants.GUARD_BACKUP_ROOT === 'string' && constants.GUARD_BACKUP_ROOT)
        || GUARD_BACKUP_ROOT_FALLBACK
      const sandboxRoot = (constants && typeof constants.SANDBOX_ROOT === 'string' && constants.SANDBOX_ROOT)
        || 'D:\\DeepseekHarness_Sandboxes'
      const dryRun = args.dryRun !== false // 默认 true(开发阶段绝不写本体)

      const reg = await registry.loadRegistry()
      const meta = registry.getSandbox(reg, args.name)
      if (!meta) throw new Error(`沙盒不存在:${args.name}`)

      const targets = normalizeTargets(args.targets, meta, bodyRoot, sandboxRoot)

      const checks = []
      const errors = []

      // ① 目标白名单。
      for (const t of targets) {
        const kind = whitelistKind(t.dst, t.bodyAbs)
        checks.push({ name: `whitelist:${t.dst}`, ok: kind.allowed, detail: kind.reason })
        if (!kind.allowed) errors.push(`${t.dst}: ${kind.reason}`)
      }

      // ② 逐文件 node --check(HTML 结构校验);源文件必须存在。
      for (const t of targets) {
        if (!existsSync(t.srcAbs)) {
          checks.push({ name: `syntax:${t.dst}`, ok: false, detail: `源文件不存在:${t.srcAbs}` })
          errors.push(`${t.dst}: 源文件不存在 ${t.srcAbs}`)
          continue
        }
        const r = await checkSyntax(t.srcAbs, exec && exec.signal)
        checks.push({ name: `syntax:${t.dst}`, ok: r.ok, detail: r.detail })
        if (!r.ok) errors.push(`${t.dst}: ${r.detail}`)
      }

      // 任一步失败即中止:只写报告,绝不写本体。
      if (errors.length > 0) {
        const report = buildReport(meta.name, 'merge', checks, 'fail', errors.join('; '))
        meta.lastReport = report
        await registry.saveRegistry(reg)
        return { ok: false, dryRun, applied: false, report, message: '门禁未通过,已中止(未写入任何本体文件)' }
      }

      // ③ 生成备份计划与回滚清单(只生成,不执行)。
      const plan = planBackup(targets, backupRoot)
      checks.push({ name: 'backup-plan', ok: true, detail: `备份目录 ${plan.backupDir}(${plan.files.length} 个文件)` })
      checks.push({ name: 'rollback-manifest', ok: true, detail: `回滚清单已生成(${plan.files.length} 条)` })

      // ④ dryRun 分支。
      if (dryRun) {
        const report = buildReport(meta.name, 'merge', checks, 'pass', '')
        meta.lastReport = report
        await registry.saveRegistry(reg)
        return {
          ok: true,
          dryRun: true,
          applied: false,
          report,
          backupDir: plan.backupDir,
          message: 'dryRun:校验通过,已生成备份计划与回滚清单,未写本体',
        }
      }

      // 真实写入守卫(开发阶段禁止,代码内写明)。
      if (process.env[MERGE_ALLOW_ENV] !== '1') {
        throw new Error(
          `真实合回被拒绝:开发阶段禁止写本体。门禁校验已通过,但必须显式设置环境变量 ${MERGE_ALLOW_ENV}=1 才会执行真实写入(见 merge-gate.js 守卫)。`,
        )
      }

      // 执行真实写入:备份先行 → 写入 → 失败即回滚 → 落盘回滚清单。
      await mkdir(plan.backupDir, { recursive: true })
      const backedUp = []
      for (const f of plan.files) {
        if (!f.isNew) {
          await mkdir(dirname(f.backup), { recursive: true })
          await copyFile(f.body, f.backup)
          backedUp.push(f)
        }
      }
      const writtenNew = []
      try {
        for (const f of plan.files) {
          await mkdir(dirname(f.body), { recursive: true })
          await copyFile(f.srcAbs, f.body)
          if (f.isNew) writtenNew.push(f.body)
        }
      } catch (error) {
        for (const f of backedUp) {
          try { await copyFile(f.backup, f.body) } catch { /* 回滚尽力而为 */ }
        }
        for (const p of writtenNew) {
          try { await rm(p, { force: true }) } catch { /* 回滚尽力而为 */ }
        }
        throw new Error(`合回写入失败,已从备份回滚:${error instanceof Error ? error.message : String(error)}`)
      }
      await writeFile(join(plan.backupDir, 'rollback-manifest.txt'), plan.manifest, 'utf8')

      const appliedFiles = plan.files.map((f) => f.dst)
      const report = buildReport(
        meta.name,
        'merge',
        [...checks, { name: 'apply', ok: true, detail: `已真实写入 ${appliedFiles.length} 个文件` }],
        'pass',
        '',
      )
      meta.lastReport = report
      await registry.saveRegistry(reg)

      return {
        ok: true,
        dryRun: false,
        applied: true,
        appliedFiles,
        backupDir: plan.backupDir,
        report,
        message: `已真实写入 ${appliedFiles.length} 个文件,备份与回滚清单在 ${plan.backupDir}`,
      }
    },
  })
}
