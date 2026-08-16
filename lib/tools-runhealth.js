/**
 * dsh-sandbox / lib/tools-runhealth.js — [M2] run/health 工具实现。
 *
 * 模块归属:agent-runmerge(仅拥有本文件与 lib/merge-gate.js,不写其它模块文件)。
 *
 * 注入契约(与 CONTRACT §4 对齐):本模块不直接 import M0 的 lib 文件,
 * 而是由 M0 的 lib/index.js 把服务对象注入进来:
 *
 *   import { sandboxRunTool, sandboxHealthTool } from './tools-runhealth.js'
 *   ctx.tools.register(sandboxRunTool(services))
 *   ctx.tools.register(sandboxHealthTool(services))
 *
 * 其中 services = { registry, ports, proctree, constants }(M0 创建):
 *   - registry  : { loadRegistry, saveRegistry, getSandbox, touchLastRun }
 *   - ports     : { allocatePort, isPortFree }
 *   - proctree  : { startSandbox, stopSandbox, sandboxAlive, body3080Owner }
 *   - constants : { SANDBOX_ROOT, REGISTRY_PATH, PORT_START, BODY_PROGRAM_SRC,
 *                   AGE_HOURS, GUARD_BACKUP_ROOT }
 *
 * 常量一律从 services.constants 读取,读不到时回退到 CONTRACT §3 的约定值,
 * 从而在 M0 把常量并入 index.js/registry.js 时依然可用。
 *
 * 政策红线(RULES.md):本模块只读本体,绝不写 D:\Deepseek harness 或
 * D:\DeepseekHarness_Data\.dsh;沙盒进程由 proctree.startSandbox 拉起,
 * 自身不直接触碰本体 3080 进程。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'

// ── 常量(回退值;优先取 services.constants)─────────────────────────────────────
const BODY_URL = 'http://127.0.0.1:3080/' // 本体固定端口,永不占用
const POLL_TIMEOUT_MS = 60000
const POLL_INTERVAL_MS = 500
const HTTP_TIMEOUT_MS = 8000
const QA_REPORT_DIR = 'D:\\ai-temp' // QA 报告落盘目录(与 bin-guard 日志同惯例)

// ── 小工具 ─────────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

/** 对 URL 发起一次 GET,返回 HTTP 状态码;网络/超时/异常统一返回 0。 */
async function httpStatus(url, timeoutMs = HTTP_TIMEOUT_MS) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ctrl.signal })
    return res.status
  } catch {
    return 0
  } finally {
    clearTimeout(timer)
  }
}

/** 轮询 URL 直到返回 200 或超时;返回 { ok, status, elapsedMs }。 */
async function pollHttp200(url, timeoutMs = POLL_TIMEOUT_MS, intervalMs = POLL_INTERVAL_MS) {
  const start = Date.now()
  const deadline = start + timeoutMs
  let last = 0
  while (Date.now() < deadline) {
    last = await httpStatus(url, Math.min(HTTP_TIMEOUT_MS, Math.max(1000, deadline - Date.now())))
    if (last === 200) {
      return { ok: true, status: last, elapsedMs: Date.now() - start }
    }
    await sleep(intervalMs)
  }
  return { ok: false, status: last, elapsedMs: Date.now() - start }
}

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

/** 判定一个值是否"长得像" CONTRACT §6 report(用于识别脚本产出)。 */
function looksLikeReport(value) {
  if (!value || typeof value !== 'object') return false
  return typeof value.kind === 'string' || typeof value.conclusion === 'string' || Array.isArray(value.checks)
}

/**
 * 从 stdout 文本里抽取 report JSON(容错脚本前置的 PASS/FAIL 日志):
 * 优先解析「最后一个 { 到最后一个 }」(报告总是最后打印),失败再退到「第一个 { 到最后一个 }」。
 */
function extractReportJson(text) {
  if (!text) return null
  const s = String(text)
  const lastClose = s.lastIndexOf('}')
  if (lastClose === -1) return null
  const lastOpen = s.lastIndexOf('{')
  if (lastOpen !== -1 && lastClose > lastOpen) {
    try {
      const v = JSON.parse(s.slice(lastOpen, lastClose + 1))
      if (looksLikeReport(v)) return v
    } catch {
      // 继续尝试下一档
    }
  }
  const firstOpen = s.indexOf('{')
  if (firstOpen !== -1 && lastClose > firstOpen) {
    try {
      const v = JSON.parse(s.slice(firstOpen, lastClose + 1))
      if (looksLikeReport(v)) return v
    } catch {
      // 忽略
    }
  }
  return null
}

/** 定位 test/qa-cdp.mjs(M4 产物)。 */
function resolveQaScript(services) {
  const candidates = []
  const fromEnv = process.env.DSH_SANDBOX_QA_SCRIPT
  if (fromEnv) candidates.push(fromEnv)
  try {
    candidates.push(fileURLToPath(new URL('../test/qa-cdp.mjs', import.meta.url)))
  } catch {
    // 忽略:包内相对路径解析失败时继续尝试其它来源
  }
  const c = services && services.constants
  if (c && typeof c.qaScript === 'string' && c.qaScript) candidates.push(c.qaScript)
  for (const p of candidates) {
    if (p && existsSync(p)) return p
  }
  return null
}

/** 从文件读取并解析 report(回退通道)。 */
async function readReportFile(path) {
  try {
    const text = await readFile(path, 'utf8')
    const value = extractReportJson(text) || (text.trim() ? JSON.parse(text) : null)
    return looksLikeReport(value) ? value : null
  } catch {
    return null
  }
}

/**
 * 运行一键 QA:spawn node test/qa-cdp.mjs <port> [name]。
 * 报告来源优先级:stdout JSON → DSH_SANDBOX_REPORT_OUT 文件 → M4 硬编码落盘路径
 *   D:\ai-temp\dsh-sandbox-qa-<port>.json → 合成的失败报告。
 * 返回 { skipped, exitCode, report }。
 */
async function runQaScript(meta, services, signal) {
  const script = resolveQaScript(services)
  if (!script) {
    return {
      skipped: true,
      exitCode: null,
      report: buildReport(
        meta.name,
        'qa',
        [{ name: 'qa-cdp', ok: false, detail: 'test/qa-cdp.mjs 不存在,跳过 QA(集成阶段由 M4 提供)' }],
        'fail',
        'QA 脚本缺失',
      ),
    }
  }

  const reportOut = process.env.DSH_SANDBOX_REPORT_OUT
    || join(QA_REPORT_DIR, `dsh-sandbox-${meta.name}-qa-report.json`)
  // M4 的 qa-cdp.mjs 固定落盘路径(见其头注释),作为额外回退。
  const m4ReportPath = join(QA_REPORT_DIR, `dsh-sandbox-qa-${meta.port}.json`)

  const child = spawn(process.execPath, [script, String(meta.port), String(meta.name || '')], {
    cwd: dirname(script),
    env: {
      ...process.env,
      DSH_SANDBOX_NAME: String(meta.name || ''),
      DSH_SANDBOX_PORT: String(meta.port || ''),
      DSH_SANDBOX_REPORT_OUT: reportOut,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    signal,
  })

  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d) => { stdout += d })
  child.stderr.on('data', (d) => { stderr += d })

  const exitCode = await new Promise((resolveExit) => {
    child.on('error', () => resolveExit(-1))
    child.on('close', (code) => resolveExit(code === null ? -1 : code))
  })

  let report = extractReportJson(stdout)
  if (!report) report = await readReportFile(reportOut)
  if (!report) report = await readReportFile(m4ReportPath)
  if (!report) {
    report = buildReport(
      meta.name,
      'qa',
      [
        { name: 'qa-cdp', ok: exitCode === 0, detail: `exit ${exitCode}` },
        { name: 'qa-output', ok: false, detail: '未取得结构化报告,回退为合成报告' },
      ],
      exitCode === 0 ? 'pass' : 'fail',
      String(stderr || stdout || '').slice(0, 400),
    )
  }
  return { skipped: false, exitCode, report }
}

// ── sandbox_run ───────────────────────────────────────────────────────────────
export function sandboxRunTool(services) {
  const registry = services && services.registry
  const proctree = services && services.proctree

  return defineTool({
    name: 'sandbox_run',
    description: '启动指定沙盒并做健康确认:预检本体 3080 未受影响 → 拉起沙盒进程 → 轮询 HTTP 200(60s 超时);qa=true 时接跑一键 QA(CDP 冒烟)并把报告写入 lastReport。',
    parameters: {
      name: { type: 'string', required: true, description: '沙盒名(需先 sandbox_create)' },
      qa: { type: 'boolean', description: 'true 时接跑 test/qa-cdp.mjs(传沙盒端口),报告写入 lastReport' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          name: { type: 'string', required: true },
          port: { type: 'number', required: true },
          pid: { type: 'number' },
          pollOk: { type: 'boolean' },
          bodyIntact: { type: 'boolean' },
          bodyPidBefore: { type: 'number' },
          bodyPidAfter: { type: 'number' },
          qa: { type: 'object', additionalProperties: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `沙盒 ${value.name} ${value.ok ? '启动成功' : '启动未完全就绪'}`
          + `(端口 ${value.port},PID ${value.pid ?? '未知'}`
          + `,HTTP 轮询 ${value.pollOk ? '200' : '未达 200'},本体 3080 ${value.bodyIntact ? '未受影响' : '异常!'}`
          + `${value.qa ? ',QA:' + (value.qa.conclusion || 'skipped') : ''})`,
      }],
    },
    timeoutMs: 180000,
    async execute(args) {
      if (!registry || !proctree) {
        throw new Error('sandbox_run: 缺少 M0 注入的 services(registry/proctree),请检查插件接线')
      }
      const reg = await registry.loadRegistry()
      const meta = registry.getSandbox(reg, args.name)
      if (!meta) throw new Error(`沙盒不存在:${args.name}(先 sandbox_create)`)
      if (meta.status === 'destroyed') throw new Error(`沙盒已销毁:${args.name}`)
      if (!meta.port) throw new Error(`沙盒缺少端口字段:${args.name}`)

      // ① 预检:记录本体 3080 监听 PID,并确认本体 3080 返回 200。
      const bodyPidBefore = await proctree.body3080Owner()
      const bodyStatus = await httpStatus(BODY_URL)
      if (bodyStatus !== 200) {
        throw new Error(`预检失败:本体 ${BODY_URL} 返回 HTTP ${bodyStatus}(应为 200),已中止,不启动沙盒`)
      }

      // ② 拉起沙盒进程(强制 env 由 proctree.startSandbox 保证)。
      const pid = await proctree.startSandbox(meta)

      // ③ 轮询沙盒 HTTP 200(60s 超时)。
      const poll = await pollHttp200(`http://127.0.0.1:${meta.port}/`, POLL_TIMEOUT_MS)

      // 复核本体 3080 监听 PID 未变(政策红线:本体进程不得受影响)。
      const bodyPidAfter = await proctree.body3080Owner()
      const bodyIntact = bodyPidBefore === bodyPidAfter

      // ④ qa=true 时接跑一键 QA。
      let qaResult = null
      if (args.qa === true) {
        qaResult = await runQaScript(meta, services)
      }

      // ⑤ 更新记录:lastRunAt / status=running / pid;QA 报告写入 lastReport。
      meta.pid = pid
      meta.status = 'running'
      meta.lastRunAt = new Date().toISOString()
      if (qaResult && !qaResult.skipped && looksLikeReport(qaResult.report)) {
        meta.lastReport = qaResult.report
      }
      await registry.saveRegistry(reg)

      const qaOk = !qaResult || qaResult.skipped || (qaResult.report && qaResult.report.conclusion === 'pass')
      const ok = poll.ok && bodyIntact && qaOk

      return {
        ok,
        name: meta.name,
        port: meta.port,
        pid,
        pollOk: poll.ok,
        bodyIntact,
        bodyPidBefore,
        bodyPidAfter,
        ...(qaResult
          ? { qa: { skipped: qaResult.skipped, exitCode: qaResult.exitCode, conclusion: qaResult.report ? qaResult.report.conclusion : null } }
          : {}),
      }
    },
  })
}

// ── sandbox_health ────────────────────────────────────────────────────────────
export function sandboxHealthTool(services) {
  const registry = services && services.registry
  const ports = services && services.ports

  return defineTool({
    name: 'sandbox_health',
    description: '对指定沙盒做健康检查:端口监听 + HTTP 200 + 可选 /plugins/dsh-sandbox/client.js 探测;产出 CONTRACT §6 格式 report 写回 lastReport 并返回。',
    parameters: {
      name: { type: 'string', required: true, description: '沙盒名' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sandbox: { type: 'string', required: true },
          at: { type: 'string', required: true },
          kind: { type: 'string', required: true },
          checks: { type: 'array', items: { type: 'object', additionalProperties: true } },
          conclusion: { type: 'string', required: true },
          excerpt: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `沙盒 ${value.sandbox} 健康检查:${value.conclusion === 'pass' ? '通过' : '失败'}`
          + (value.excerpt ? `(${value.excerpt})` : ''),
      }],
    },
    timeoutMs: 30000,
    async execute(args) {
      if (!registry || !ports) {
        throw new Error('sandbox_health: 缺少 M0 注入的 services(registry/ports),请检查插件接线')
      }
      const reg = await registry.loadRegistry()
      const meta = registry.getSandbox(reg, args.name)
      if (!meta) throw new Error(`沙盒不存在:${args.name}`)
      if (!meta.port) throw new Error(`沙盒缺少端口字段:${args.name}`)

      const checks = []

      // 端口监听:isPortFree 为 false 即端口被占用(视为监听中)。
      let listening = false
      try {
        listening = !(await ports.isPortFree(meta.port))
      } catch {
        listening = false
      }
      checks.push({ name: 'port-listening', ok: listening, detail: `端口 ${meta.port} ${listening ? '监听中' : '未监听'}` })

      // HTTP 200。
      const status = await httpStatus(`http://127.0.0.1:${meta.port}/`)
      checks.push({ name: 'http-200', ok: status === 200, detail: `HTTP ${status}` })

      // 可选:客户端 bundle 探测(未注册客户端插件时 404 属正常,不影响结论)。
      const cjStatus = await httpStatus(`http://127.0.0.1:${meta.port}/plugins/dsh-sandbox/client.js`)
      checks.push({
        name: 'client-bundle',
        ok: cjStatus === 200,
        detail: `client.js HTTP ${cjStatus}${cjStatus !== 200 ? '(可选探测,未注册客户端插件时 404 属正常)' : ''}`,
      })

      const hardOk = listening && status === 200
      const conclusion = hardOk ? 'pass' : 'fail'
      const excerpt = hardOk ? '' : (listening ? `HTTP ${status}` : `端口 ${meta.port} 未监听`)
      const report = buildReport(meta.name, 'health', checks, conclusion, excerpt)

      meta.lastReport = report
      await registry.saveRegistry(reg)

      return report
    },
  })
}
