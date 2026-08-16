/**
 * lib/proctree.js — 沙盒进程树管理(M0 core)。
 *
 * 契约(CONTRACT §4):
 * - startSandbox(meta):直接 `node <programDir>\node_modules\@deepseek-ai\dsh\lib\bin.js
 *   web --port <p>` 拉起沙盒进程,强制 env DSH_HOME=<meta.home>、DSH_INSTALL_DIR=<meta.programDir>,
 *   返回 pid。
 * - stopSandbox(meta):按 pid 终止进程树;终止前校验树内不含本体 3080 监听 PID,含则抛错拒绝。
 * - sandboxAlive(meta):进程存在 + 端口监听双重确认。
 * - body3080Owner():返回当前 3080 监听 PID 或 null(供 run 预检对比)。
 *
 * 安全红线(RULES §2):任何情况下不得终止监听 3080 的进程。
 * 因此 stopSandbox 在 taskkill 之前先反查 3080 owner,并校验其不在待杀进程树内。
 *
 * 说明:本模块跑在 DSH 宿主进程内(非沙盒),拥有完整访问权限,
 * 因此可用 child_process 捕获 PowerShell 输出做端口/PID 反查。
 * @module dsh-sandbox/proctree
 */
import { execFile, spawn } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** 统一的 PowerShell 调用入口(禁用 profile/交互,隐藏窗口,限时)。 */
function runPowershell(script) {
  return execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
    timeout: 15000,
  })
}

/**
 * 返回当前监听 3080 端口的进程 PID;无人监听或查询失败返回 null。
 * @returns {Promise<number | null>}
 */
export async function body3080Owner() {
  try {
    const { stdout } = await runPowershell(
      "(Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique) -join ','"
    )
    const text = String(stdout).trim()
    if (!text) return null
    const pid = Number.parseInt(text.split(',')[0].trim(), 10)
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

/**
 * 判断进程是否存在(Windows:process.kill(pid, 0) 不存在抛 ESRCH,存在但无权限抛 EPERM)。
 * @param {number} pid - 进程 PID。
 * @returns {boolean}
 */
function pidExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return Boolean(error) && error.code === 'EPERM'
  }
}

/**
 * 判断端口是否正被监听(用于 sandboxAlive 的端口侧确认)。
 * @param {number} port - 端口号。
 * @returns {Promise<boolean>}
 */
async function portListening(port) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return false
  try {
    const { stdout } = await runPowershell(
      `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Measure-Object).Count`
    )
    return Number.parseInt(String(stdout).trim(), 10) > 0
  } catch {
    return false
  }
}

/**
 * 枚举 rootPid 的进程树后代 PID 集合(含孙子级,不含 root 自身)。
 * 用 Get-CimInstance Win32_Process 建 parent→children 邻接表后 BFS。
 * @param {number} rootPid - 根进程 PID。
 * @returns {Promise<Set<number>>}
 */
async function processDescendants(rootPid) {
  const script = `
$r = [int]${rootPid}
$m = @{}
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object {
  $p = [int]$_.ParentProcessId
  if (-not $m.ContainsKey($p)) { $m[$p] = @() }
  $m[$p] += [int]$_.ProcessId
}
$seen = @{}
$queue = New-Object System.Collections.Queue
$queue.Enqueue($r)
while ($queue.Count -gt 0) {
  $c = $queue.Dequeue()
  if ($m.ContainsKey($c)) {
    foreach ($x in $m[$c]) {
      if (-not $seen.ContainsKey($x)) { $seen[$x] = $true; $queue.Enqueue($x) }
    }
  }
}
($seen.Keys | Sort-Object) -join ','
`
  try {
    const { stdout } = await runPowershell(script)
    const text = String(stdout).trim()
    if (!text) return new Set()
    return new Set(
      text.split(',').map((s) => Number.parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n) && n > 0)
    )
  } catch {
    return new Set()
  }
}

/**
 * 拉起沙盒进程:直接 node bin.js web --port <p>,不经过 bin-guard(守卫只服务本体)。
 * 强制 env DSH_HOME / DSH_INSTALL_DIR,保证沙盒使用独立 home 与独立程序目录。
 * 等待 'spawn' 事件确认进程真正拉起后返回 pid;node 缺失等失败抛错。
 * @param {object} meta - 沙盒记录(至少含 programDir/home/port)。
 * @returns {Promise<number>} 沙盒根进程 PID。
 */
export async function startSandbox(meta) {
  if (!meta || typeof meta.programDir !== 'string' || meta.programDir === '') {
    throw new Error('startSandbox: meta.programDir 缺失')
  }
  if (!Number.isInteger(meta.port) || meta.port <= 0) {
    throw new Error(`startSandbox: meta.port 无效:${String(meta.port)}`)
  }
  const bin = join(meta.programDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  return await new Promise((resolve, reject) => {
    const child = spawn('node', [bin, 'web', '--port', String(meta.port)], {
      env: { ...process.env, DSH_HOME: meta.home, DSH_INSTALL_DIR: meta.programDir },
      stdio: 'ignore',
      cwd: meta.programDir,
      windowsHide: true,
    })
    child.once('error', (error) => {
      reject(new Error(`startSandbox: 无法拉起沙盒进程:${error instanceof Error ? error.message : String(error)}`))
    })
    child.once('spawn', () => {
      resolve(child.pid)
    })
  })
}

/**
 * 终止沙盒进程树(仅沙盒 PID 树,与本体进程树严格区分)。
 * 终止前反查 3080 owner:若 meta.pid 即 owner,或其进程树内包含 owner,抛错拒绝,
 * 绝不触碰本体进程(RULES §2 / CONTRACT §4)。
 * @param {object} meta - 沙盒记录(至少含 pid)。
 * @returns {Promise<boolean>}
 */
export async function stopSandbox(meta) {
  if (!meta || !Number.isInteger(meta.pid) || meta.pid <= 0) {
    throw new Error(`stopSandbox: meta.pid 无效:${String(meta && meta.pid)}`)
  }
  const owner = await body3080Owner()
  if (owner !== null) {
    if (meta.pid === owner) {
      throw new Error(`stopSandbox: 拒绝终止 —— PID ${meta.pid} 是本体 3080 监听进程,禁止触碰`)
    }
    const descendants = await processDescendants(meta.pid)
    if (descendants.has(owner)) {
      throw new Error(`stopSandbox: 拒绝终止 —— 沙盒进程树内含本体 3080 监听 PID ${owner},终止会连累本体`)
    }
  }
  try {
    await execFileAsync('taskkill', ['/PID', String(meta.pid), '/T', '/F'], { windowsHide: true })
  } catch (error) {
    throw new Error(`stopSandbox: taskkill 失败:${error instanceof Error ? error.message : String(error)}`)
  }
  return true
}

/**
 * 沙盒存活判断:进程存在 且 端口监听,双重确认。
 * @param {object} meta - 沙盒记录(至少含 pid/port)。
 * @returns {Promise<boolean>}
 */
export async function sandboxAlive(meta) {
  if (!meta || !Number.isInteger(meta.pid) || meta.pid <= 0) return false
  if (!pidExists(meta.pid)) return false
  return portListening(meta.port)
}
