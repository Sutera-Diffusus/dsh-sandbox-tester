/**
 * lib/ports.js — 沙盒端口池(M0 core)。
 *
 * 契约(CONTRACT §4):
 * - allocatePort(start = PORT_START):探测监听,返回可用端口,冲突自动 +1 重试。
 * - isPortFree(port):判断某端口是否空闲。
 *
 * 实现:用 node:net 创建临时 server 尝试 listen(port, '127.0.0.1'):
 * 成功(收到 'listening')即 close 并判定空闲;失败(收到 'error',如 EADDRINUSE)
 * 判定占用。沙盒 DSH web 服务绑定 127.0.0.1,因此按 127.0.0.1 探测与本契约一致。
 *
 * 端口段划分(DESIGN §4.4/§9):本体 3080 / 固定桥接副本 3181 / 沙盒 3182+。
 * @module dsh-sandbox/ports
 */
import net from 'node:net'
import { PORT_START } from './registry.js'

/**
 * 单次探测:尝试监听某端口,返回是否空闲。
 * 用 close 回调确保 socket 完全释放后才判定空闲,避免 TIME_WAIT 误判。
 * @param {number} port - 待探测端口。
 * @returns {Promise<boolean>}
 */
function probe(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    let settled = false
    const finish = (free) => {
      if (settled) return
      settled = true
      resolve(free)
    }
    server.once('error', () => finish(false))
    server.once('listening', () => {
      server.close(() => finish(true))
    })
    server.listen(port, '127.0.0.1')
  })
}

/**
 * 判断端口是否空闲(可被本进程监听)。
 * @param {number} port - 待判断端口。
 * @returns {Promise<boolean>}
 */
export async function isPortFree(port) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return false
  return probe(port)
}

/**
 * 分配一个可用端口:从 start 起逐个探测,命中空闲即返回,冲突 +1 重试。
 * 设 1000 次上限防死循环;端口段耗尽时抛错。
 * @param {number} [start] - 起始端口,默认 PORT_START(3182)。
 * @returns {Promise<number>}
 */
export async function allocatePort(start = PORT_START) {
  let port = Number.isInteger(start) && start > 0 ? start : PORT_START
  const cap = port + 1000
  for (; port < cap && port <= 65535; port += 1) {
    // eslint-disable-next-line no-await-in-loop -- 探测必须串行,冲突才 +1
    if (await probe(port)) return port
  }
  throw new Error(`allocatePort: 从 ${start} 起连续探测 1000 个端口均被占用,未找到可用端口`)
}
