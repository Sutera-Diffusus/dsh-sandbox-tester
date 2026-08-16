/**
 * dsh-sandbox — DSH 测试沙盒插件(M0 core:宿主核心 + 插件骨架)。
 *
 * 定位(DESIGN §2.2):本插件跑在宿主进程内,只做「沙盒编排器」,自身绝不执行危险代码;
 * 真隔离的唯一边界是操作系统进程——沙盒由独立进程 + 独立 DSH_HOME + 独立端口构成。
 *
 * 本文件(M0)职责:
 * 1. 组装宿主服务对象 services = { registry, ports, proctree, constants };
 * 2. 注册 9 个原生工具(实现来自 M1/M2 模块,并行开发中可能尚未产出,
 *    故用「动态 import + try/catch」,失败时注册返回「模块未就绪」的占位工具);
 * 3. 注册 settings 命名空间 'sandbox'(键:SANDBOX_ROOT / PORT_START / AGE_HOURS,默认值按 CONTRACT §3);
 * 4. 以与 dsh-github 相同的客户端插件形态接入(bundle `dsh.client: { platform: 'web' }`
 *    由 package.json 声明,`./client` 由 M3 的 client/client.js 提供)。
 *
 * 工具实现模块约定(并行开发中 M1/M2 出现了两种导出形态,本入口两种都兼容):
 * 形态 A(注入式工厂,M2 采用,与 CONTRACT §4 对齐):
 *   - lib/tools-runhealth.js 导出 `sandboxRunTool(services)` / `sandboxHealthTool(services)`;
 *   - lib/merge-gate.js 导出 `sandboxMergeTool(services)`;
 *   每个工厂接收 services 并返回 defineTool({...}) 定义。识别规则:导出名以 `Tool` 结尾。
 * 形态 B(裸 execute 函数 + default 汇总表,M1 采用):
 *   - lib/tools-lifecycle.js 导出 `sandbox_list(args)` 等 6 个 async 执行函数,
 *     并导出 `default = { sandbox_list, ... }` 汇总表;由 M0 在此处包装成 defineTool。
 *   识别规则:导出名等于工具名本身(snake_case),函数签名是 `(args)` 而非 `(services)`。
 * 通用兜底:也接受 `createTools(services)` / `default(services)` 工厂返回工具数组,
 * 或直接导出 defineTool 定义对象/数组。
 * 任一模块 import 失败(文件缺失/语法错误/依赖缺失)时,只对该模块工具注册占位,
 * 其余模块照常注册;占位工具调用时返回「模块未就绪:M1/M2 尚未产出」。
 *
 * @module dsh-sandbox
 */
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  loadRegistry, saveRegistry, getSandbox, touchLastRun,
  SANDBOX_ROOT, REGISTRY_PATH, PORT_START, BODY_PROGRAM_SRC, AGE_HOURS, GUARD_BACKUP_ROOT,
} from './registry.js'
import { allocatePort, isPortFree } from './ports.js'
import { startSandbox, stopSandbox, sandboxAlive, body3080Owner } from './proctree.js'

/** Cordis 插件名(loader 诊断用;与内置 dsh-sandbox-local 的 'sandbox' 服务名区分)。 */
export const name = 'dsh-sandbox'
/** 依赖的服务:工具注册表(ctx.tools)。settings 由 installSettingsSection 动态注入。 */
export const inject = ['tools']

/**
 * 插件配置(同时作为 settings 命名空间 'sandbox' 的 schema):
 * 三个键即设置页区段的字段,默认值按 CONTRACT §3。
 */
export const Config = z.object({
  SANDBOX_ROOT: z.string().default(SANDBOX_ROOT),
  PORT_START: z.number().default(PORT_START),
  AGE_HOURS: z.number().default(AGE_HOURS),
})

/** settings 命名空间(白名单 'sandbox',见 DESIGN §4.1)。 */
const SANDBOX_NS = settingsNamespace('sandbox')

/**
 * 共享常量(供 M1/M2 直接 import):从 registry.js 转发,导出名与 CONTRACT §3 一致。
 * 也可经 services.constants 取得。
 */
export {
  SANDBOX_ROOT, REGISTRY_PATH, PORT_START, BODY_PROGRAM_SRC, AGE_HOURS, GUARD_BACKUP_ROOT,
}

/** 9 个工具的归属映射:哪个模块提供、由哪个代理开发。顺序按 CONTRACT §5。 */
const TOOL_SOURCES = [
  { module: './tools-lifecycle.js', owner: 'M1', names: ['sandbox_list', 'sandbox_create', 'sandbox_inject', 'sandbox_stop', 'sandbox_destroy', 'sandbox_prune'] },
  { module: './tools-runhealth.js', owner: 'M2', names: ['sandbox_run', 'sandbox_health'] },
  { module: './merge-gate.js', owner: 'M2', names: ['sandbox_merge'] },
]

/**
 * 占位工具:模块未就绪时注册,调用即返回「模块未就绪」,避免工具名缺失导致模型报错。
 * @param {string} toolName - 工具名(与正式实现一致)。
 * @param {{ module: string, owner: string }} source - 来源模块信息。
 */
function placeholderTool(toolName, source) {
  return defineTool({
    name: toolName,
    description: `(占位)${toolName}:模块 ${source.module} 尚未产出,等待 ${source.owner} 接线;当前调用会返回「模块未就绪」。`,
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          ready: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    timeoutMs: 30000,
    async execute() {
      return { ok: false, ready: false, message: `模块未就绪:M1/M2 尚未产出(${source.module} 由 ${source.owner} 提供,当前未加载)` }
    },
  })
}

/** snake_case → camelCase:供「工具名 → 工厂名(sandboxXxxTool)」推导。 */
function camelize(snake) {
  return snake.replace(/_([a-z])/g, (_match, char) => char.toUpperCase())
}

/**
 * M1 六个生命周期工具的真实参数 schema 与描述(CONTRACT §5 / DESIGN §3.1)。
 * M2 工具(run/health/merge)自带 defineTool 定义,不走本表;本表只服务 M1 裸 execute 函数,
 * 由 wrapExecuteTool 包装成带真实签名(而非占位 {})的注册。
 */
const M1_TOOL_META = {
  sandbox_list: {
    description: '列出所有沙盒:名称/状态(运行中·已停止·已销毁)/端口/home/年龄/最近一次报告结论(含 48h 超龄标记)。',
    parameters: {},
  },
  sandbox_create: {
    description: '从本体程序目录复制出一个进程级隔离的沙盒(独立进程 + 独立 home + 独立端口):默认裁剪复制(排除 Launcher.exe/WebView2/backups/.npm-cache/运行态文件),fullCopy=true 时全量;自动分配未占用端口(默认 3182 起);写 start-sandbox.bat 与 meta.json,注册表 status=stopped。',
    parameters: {
      name: { type: 'string', description: '沙盒名(字母/数字开头,可含 . _ -,最长 64)' },
      basePort: { type: 'number', description: '起始端口(默认 3182 起自动分配;本体 3080 与固定副本 3181 永不占用)' },
      fullCopy: { type: 'boolean', description: 'true 时完整复制本体程序;默认裁剪' },
    },
  },
  sandbox_inject: {
    description: '把补丁应用到沙盒 program 目录内(先备份到 .inject-backups 并写回滚清单,严格校验每个目标路径落在沙盒 program 之内,越界抛错)。',
    parameters: {
      name: { type: 'string', required: true, description: '沙盒名' },
      patch: { type: 'json', required: true, description: '补丁对象或 JSON 字符串:{ files: [{ path, content } | { path, source } | { path, delete: true }] },或单文件 { path, content }' },
    },
  },
  sandbox_stop: {
    description: '停止沙盒进程树(仅沙盒 PID 树;终止前反查本体 3080 监听 PID,树内含 3080 则拒绝,绝不触碰本体进程)。',
    parameters: {
      name: { type: 'string', required: true, description: '沙盒名' },
    },
  },
  sandbox_destroy: {
    description: '停止并删除沙盒目录与 home,回收磁盘;需 confirm=true 显式确认(防误删)。',
    parameters: {
      name: { type: 'string', required: true, description: '沙盒名' },
      confirm: { type: 'boolean', required: true, description: '必须为 true 才执行销毁' },
    },
  },
  sandbox_prune: {
    description: '清理孤儿沙盒(进程已死且超龄的目录);默认 48h 超龄标记,dryRun=true 仅列出候选不删除。',
    parameters: {
      dryRun: { type: 'boolean', description: 'true 时仅列出待清理候选,不执行删除' },
    },
  },
}

/**
 * 把 M1 形态的裸 execute 函数包装成 defineTool 定义。
 * 只包装、不执行:fn 仅在工具被调用时运行,注册期绝不触发任何副作用。
 * @param {string} toolName - 工具名。
 * @param {Function} fn - 形如 async (args) => 结果对象 的执行函数。
 * @param {{ description?: string, parameters?: object }} [meta] - 该工具的描述与参数 schema(来自 M1_TOOL_META)。
 */
function wrapExecuteTool(toolName, fn, meta = {}) {
  const description = meta.description || `${toolName} — dsh-sandbox 沙盒工具`
  const parameters = meta.parameters || {}
  return defineTool({
    name: toolName,
    description,
    parameters,
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{
        type: 'text',
        text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
      }],
    },
    timeoutMs: 600000,
    async execute(args) {
      return await fn(args)
    },
  })
}

/**
 * 从某一来源模块加载工具定义(兼容 M1/M2 两种导出形态,见文件头注释):
 * - import 失败(文件缺失/语法错误/依赖缺失)→ 该模块全部工具注册占位;
 * - 形态 A:以 `Tool` 结尾的导出视为工厂,`await 工厂(services)` 取 defineTool 定义;
 * - 形态 B:导出名等于工具名(snake_case)的函数视为裸 execute,包装注册(不在注册期执行);
 * - 通用:`createTools(services)` / `default(services)` 工厂;default 为对象时按「名→execute」表处理;
 * - 直接导出的 defineTool 定义对象/数组直接收集;
 * - 最终按工具名归并,缺失者以占位补齐(单个工具缺失只占位该工具)。
 * @param {object} source - { module, owner, names } 来源描述。
 * @param {object} services - 注入给工具实现的服务对象。
 * @param {object} ctx - 插件上下文(日志用)。
 * @returns {Promise<Array>} 该来源模块对应的全部工具定义(含占位)。
 */
async function loadToolsFor(source, services, ctx) {
  const warn = (message) => ctx.logger.warn(`dsh-sandbox: ${message}`)
  const messageOf = (error) => (error instanceof Error && error.message ? error.message : String(error))
  const placeholders = source.names.map((toolName) => placeholderTool(toolName, source))

  let mod
  try {
    mod = await import(source.module)
  } catch (error) {
    warn(`加载 ${source.module} 失败,${source.names.length} 个工具暂以占位注册:${messageOf(error)}`)
    return placeholders
  }

  const defs = []
  const collect = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) if (item && typeof item.name === 'string') defs.push(item)
      return
    }
    if (value && typeof value.name === 'string') defs.push(value)
  }
  const has = (toolName) => defs.some((def) => def.name === toolName)

  // ① 通用工厂:createTools(services) 或 default(services)
  const factory =
    typeof mod.createTools === 'function' ? mod.createTools
      : typeof mod.default === 'function' ? mod.default
        : null
  if (factory) {
    try { collect(await factory(services)) } catch (error) { warn(`调用 ${source.module} 工厂失败:${messageOf(error)}`) }
  }

  // ② default 为「工具名 → execute 函数」汇总表(M1 形态):逐个包装,不执行
  if (mod.default && typeof mod.default === 'object' && !Array.isArray(mod.default)) {
    for (const [toolName, fn] of Object.entries(mod.default)) {
      if (typeof fn === 'function' && source.names.includes(toolName) && !has(toolName)) {
        defs.push(wrapExecuteTool(toolName, fn, M1_TOOL_META[toolName]))
      }
    }
  }

  // ③ 命名导出:按候选名匹配(M2 的 sandboxXxxTool 工厂 / M1 的 sandbox_xxx 裸函数 / 直接导出定义)
  for (const toolName of source.names) {
    const candidates = [toolName, `${camelize(toolName)}Tool`, `${toolName}_tool`, `${toolName}Tool`]
    for (const key of candidates) {
      const value = mod[key]
      if (value === undefined) continue
      if (typeof value === 'function') {
        if (key.endsWith('Tool')) {
          try { collect(await value(services)) } catch (error) { warn(`调用 ${source.module}.${key}(services) 失败:${messageOf(error)}`) }
        } else if (key === toolName && !has(toolName)) {
          defs.push(wrapExecuteTool(toolName, value, M1_TOOL_META[toolName]))
        }
      } else {
        collect(value)
      }
    }
  }

  const byName = new Map()
  for (const def of defs) if (def && typeof def.name === 'string') byName.set(def.name, def)
  return source.names.map((toolName) => {
    const def = byName.get(toolName)
    if (!def) warn(`模块 ${source.module} 未提供工具 ${toolName},以占位工具补齐`)
    return def ?? placeholderTool(toolName, source)
  })
}

/**
 * 插件入口:组装服务、注册设置命名空间、加载并注册 9 个工具。
 * @param {object} ctx - Cordis 插件上下文。
 * @param {object} config - 解析后的插件配置(含 Config 默认值)。
 */
export async function apply(ctx, config) {
  // ── 宿主服务对象(CONTRACT §4 规定形状)───────────────────────────────────
  const services = {
    registry: { loadRegistry, saveRegistry, getSandbox, touchLastRun },
    ports: { allocatePort, isPortFree },
    proctree: { startSandbox, stopSandbox, sandboxAlive, body3080Owner },
    constants: Object.freeze({ SANDBOX_ROOT, REGISTRY_PATH, PORT_START, BODY_PROGRAM_SRC, AGE_HOURS, GUARD_BACKUP_ROOT }),
  }

  // ── settings 命名空间 'sandbox' ─────────────────────────────────────────
  // base 层用当前插件配置(含默认值),用户可在设置页覆盖;解析值经 currentSettings 供 UI 读取。
  const entry = {
    SANDBOX_ROOT: config?.SANDBOX_ROOT ?? SANDBOX_ROOT,
    PORT_START: config?.PORT_START ?? PORT_START,
    AGE_HOURS: config?.AGE_HOURS ?? AGE_HOURS,
  }
  let currentSettings = () => entry
  installSettingsSection(ctx, SANDBOX_NS, Config, entry, {
    setSource: (source) => {
      currentSettings = source
    },
    onChange: () => {
      ctx.logger.debug(`dsh-sandbox: settings 'sandbox' 已更新:${JSON.stringify(currentSettings())}`)
    },
  })

  // ── 提供 'dsh-sandbox' 服务 seam(UI/集成阶段可用 settings() 读实时配置;避开内置 'sandbox' 服务名)──────
  ctx.provide('dsh-sandbox', { ...services, settings: () => currentSettings() })

  // ── 注册 9 个原生工具(动态 import M1/M2,失败则占位)─────────────────────
  const toolDefs = []
  for (const source of TOOL_SOURCES) {
    toolDefs.push(...(await loadToolsFor(source, services, ctx)))
  }
  for (const def of toolDefs) {
    ctx.tools.register(def)
  }
  const placeholderCount = toolDefs.filter((def) => /\(占位\)/.test(def.description)).length
  ctx.logger.info(
    `dsh-sandbox: 已注册 ${toolDefs.length} 个沙盒工具` +
    (placeholderCount > 0 ? `(${placeholderCount} 个占位,等待 M1/M2 接线)` : '')
  )
}
