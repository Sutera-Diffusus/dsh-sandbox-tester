#!/usr/bin/env node
/**
 * dsh-sandbox 一键 QA(CDP 9223 驱动 headless Edge,手法参照 dsh-github/test/*.mjs):
 *   node test/qa-cdp.mjs <sandbox-port> [sandbox-name]
 *
 * 检查项(对应 DESIGN §4.6):
 *   1. http-home-200          首页 HTTP 200
 *   2. http-client-200        /plugins/dsh-sandbox/client.js HTTP 200(关键 bundle)
 *   3. settings-render        设置页渲染,且包含 "测试沙盒" 区段文本
 *   4. console-no-uncaught    控制台无未捕获异常(Runtime.exceptionThrown 为空)
 *
 * 产出 CONTRACT §6 格式 report.json:
 *   - 写盘 D:\ai-temp\dsh-sandbox-qa-<port>.json
 *   - stdout 打印完整 JSON
 * 结论为 fail 时进程退出码 1(供 sandbox_run --qa 判断)。
 *
 * 说明:本脚本只对 127.0.0.1:<port>(沙盒)与 127.0.0.1:9223(CDP)发起连接,
 * 不启动任何进程,也不触碰本体 3080。CDP 不可达时,两个 CDP 项按失败记录,HTTP 项不受影响。
 */
import { writeFileSync, mkdirSync } from 'node:fs';

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error('用法: node test/qa-cdp.mjs <sandbox-port> [sandbox-name]');
  process.exit(2);
}
const sandboxName = process.argv[3] || ('sandbox-' + port);
const APP_ORIGIN = `http://127.0.0.1:${port}`;
const APP = APP_ORIGIN + '/';
const CDP = process.env.DSH_QA_CDP || 'http://127.0.0.1:9223';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

let activeWs = null; // 供 finalize 兜底关闭,避免 ws 句柄挂住事件循环

const checks = [];
function record(name, ok, detail = '') {
  checks.push({ name, ok: !!ok, detail: String(detail ?? '') });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// ── HTTP 检查(不依赖 CDP)───────────────────────────────────────────────────
async function httpGet(url, timeoutMs = 15000) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  return res;
}

async function httpChecks() {
  // 1. 首页 200
  try {
    const res = await httpGet(APP);
    record('http-home-200', res.status === 200, `status=${res.status}`);
  } catch (e) {
    record('http-home-200', false, e?.message ?? String(e));
  }
  // 2. 关键 bundle 200
  try {
    const res = await httpGet(APP_ORIGIN + '/plugins/dsh-sandbox/client.js');
    const body = await res.text();
    const nonEmpty = body.length > 0 && !body.trim().startsWith('<!DOCTYPE') && !body.trim().startsWith('<');
    record('http-client-200', res.status === 200 && nonEmpty, `status=${res.status} bytes=${body.length}`);
  } catch (e) {
    record('http-client-200', false, e?.message ?? String(e));
  }
}

// ── CDP 检查 ────────────────────────────────────────────────────────────────
// 按 url 过滤 target:先在 /json/list 里找指向沙盒 origin 的 page target,
// 找不到再用 /json/new 新建一个(与 dsh-github 的 /json/new 手法一致)。
async function findOrCreateTarget() {
  try {
    const list = await (await fetch(CDP + '/json/list', { signal: AbortSignal.timeout(5000) })).json();
    const hit = (Array.isArray(list) ? list : []).find(
      (t) => t && t.type === 'page' && typeof t.url === 'string' && t.url.startsWith(APP_ORIGIN),
    );
    if (hit?.webSocketDebuggerUrl) {
      console.log('CDP target(按 url 过滤命中):', hit.url);
      return hit;
    }
  } catch {
    /* 列表不可用则走 /json/new */
  }
  const created = await fetch(CDP + '/json/new?' + encodeURIComponent(APP), {
    method: 'PUT',
    signal: AbortSignal.timeout(8000),
  });
  if (!created.ok) throw new Error('/json/new HTTP ' + created.status);
  const target = await created.json();
  if (!target?.webSocketDebuggerUrl) throw new Error('/json/new 未返回 webSocketDebuggerUrl');
  console.log('CDP target(新建):', target.url || APP);
  return target;
}

async function cdpChecks() {
  const target = await findOrCreateTarget();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  ws.binaryType = 'arraybuffer'; // 关键:事件载荷按 arraybuffer 收,再转 utf8
  activeWs = ws;
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  let id = 0;
  const pending = new Map(); // id -> {resolve,reject}
  const waiters = new Map(); // method -> [{resolve,filter}]
  const uncaught = []; // Runtime.exceptionThrown(未捕获异常)
  const consoleErrors = []; // console.error / Log.error(仅作 detail 参考,不作硬性失败)

  ws.addEventListener('message', (event) => {
    let raw = event.data;
    if (raw instanceof ArrayBuffer) raw = Buffer.from(raw).toString('utf8');
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
      return;
    }
    // 事件(无 id)
    const m = msg.method;
    if (m === 'Runtime.exceptionThrown') {
      const d = msg.params?.exceptionDetails;
      uncaught.push(d?.exception?.description || d?.text || JSON.stringify(d || {}));
    } else if (m === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
      const args = (msg.params.args || []).map((a) => (a.value ?? a.description ?? '')).join(' ');
      consoleErrors.push('console.error: ' + args);
    } else if (m === 'Log.entryAdded' && msg.params?.entry?.level === 'error') {
      consoleErrors.push('log.error: ' + (msg.params.entry.text || ''));
    }
    const arr = waiters.get(m);
    if (arr?.length) {
      const i = arr.findIndex((w) => !w.filter || w.filter(msg));
      if (i >= 0) arr.splice(i, 1)[0].resolve(msg);
    }
  });

  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const callId = ++id;
    pending.set(callId, { resolve, reject });
    ws.send(JSON.stringify({ id: callId, method, params }));
  });
  const once = (method, filter, timeoutMs = 20000) => new Promise((resolve, reject) => {
    const w = { resolve, filter };
    const arr = waiters.get(method) || waiters.set(method, []).get(method);
    arr.push(w);
    setTimeout(() => {
      const list = waiters.get(method);
      const i = list?.indexOf(w);
      if (i >= 0) { list.splice(i, 1); reject(new Error('等待事件超时: ' + method)); }
    }, timeoutMs);
  });
  async function evaluate(expression) {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result?.value;
  }

  // 启用域 + 干净重载(确保从重载起捕获未捕获异常,避免错过 Runtime.enable 之前的首屏异常)
  await call('Page.enable');
  await call('Runtime.enable');
  await call('Log.enable');
  const load = once('Page.loadEventFired', null, 20000).catch(() => {});
  await call('Page.navigate', { url: APP });
  await load;
  await delay(4000);

  // 关欢迎/引导(尽力而为,找不到不报错;含 API Key 配置弹窗)
  await evaluate("(() => { const b = [...document.querySelectorAll('button')].find((x) => ['继续','稍后配置','保存并继续','跳过'].includes((x.textContent||'').trim())); if (b) b.click(); return !!b; })()").catch(() => {});
  await delay(1500);
  // 点侧栏设置入口(真实入口是 class 含 VOzbGW_trigger 的无文本按钮;文本查找仅作兜底)
  const settingsEntryInfo = await evaluate(`(() => {
    const t = document.querySelector('[class*="VOzbGW_trigger"]');
    if (t) {
      t.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return { clicked: true, via: 'class', cls: String(t.className).slice(0, 60) };
    }
    const leaves = [...document.querySelectorAll('*')].filter((x) => (x.textContent || '').trim() === '设置' && x.children.length === 0);
    let f = leaves[0];
    if (!f) f = [...document.querySelectorAll('*')].find((x) => (x.textContent || '').trim() === '设置');
    if (f) {
      f.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return { clicked: true, via: 'text', tag: f.tagName };
    }
    return { clicked: false, sidebarText: (document.body ? document.body.innerText.slice(0, 500) : '') };
  })()`).catch((e) => ({ clicked: false, err: String(e) }));
  await delay(2500);
  // 点进 "测试沙盒" 区段(尽力而为)
  const sectionClicked = await evaluate("(() => { const items = [...document.querySelectorAll('button, [role=button], [role=tab]')].filter((b) => (b.textContent || '').trim() === '测试沙盒'); if (items[0]) { items[0].click(); return true; } return false; })()").catch(() => false);
  await delay(1500);

  // 3. 设置页渲染(含 "测试沙盒" 区段文本)
  const hasTestSandbox = await evaluate("document.body && document.body.innerText.includes('测试沙盒')");
  record(
    'settings-render',
    hasTestSandbox === true,
    hasTestSandbox === true
      ? `设置页已渲染,含"测试沙盒"区段文本(sectionClicked=${sectionClicked === true}, entry=${JSON.stringify(settingsEntryInfo)})`
      : `设置页未找到"测试沙盒"区段文本(sectionClicked=${sectionClicked === true}, entry=${JSON.stringify(settingsEntryInfo)})`,
  );

  // 4. 控制台无未捕获异常
  record(
    'console-no-uncaught',
    uncaught.length === 0,
    uncaught.length === 0
      ? '无未捕获异常' + (consoleErrors.length ? `(console.error ${consoleErrors.length} 条,仅供参考)` : '')
      : `${uncaught.length} 个未捕获异常: ${uncaught.slice(0, 3).map((s) => String(s).slice(0, 200)).join(' | ')}`,
  );

  ws.close();
}

// ── 汇总与报告 ──────────────────────────────────────────────────────────────
let finalized = false;
function finalize() {
  if (finalized) return;
  finalized = true;
  clearTimeout(watchdog);
  try { activeWs?.close(); } catch { /* ws 已关闭或未建立 */ }
  const conclusion = checks.every((c) => c.ok) ? 'pass' : 'fail';
  const excerpt = checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join('; ');
  const report = {
    sandbox: sandboxName,
    at: new Date().toISOString(),
    kind: 'qa',
    checks,
    conclusion,
    excerpt,
  };
  const outPath = `D:/ai-temp/dsh-sandbox-qa-${port}.json`;
  try {
    mkdirSync('D:/ai-temp', { recursive: true });
    writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
  } catch (e) {
    console.error('报告写盘失败:', e?.message ?? e);
  }
  console.log('\nREPORT ' + outPath);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = conclusion === 'pass' ? 0 : 1;
  // 兜底:确保脚本必定退出(先让 stdout flush;即使 ws 句柄未释放也强制退出)
  setTimeout(() => process.exit(process.exitCode ?? 0), 250);
}

const WATCHDOG_MS = 120000;
const watchdog = setTimeout(() => {
  console.error('[qa-cdp] 超过 ' + WATCHDOG_MS + 'ms,强制结束');
  finalize();
}, WATCHDOG_MS);

try {
  await httpChecks();
  try {
    await cdpChecks();
  } catch (e) {
    record('settings-render', false, 'CDP 不可用: ' + (e?.message ?? e));
    record('console-no-uncaught', false, 'CDP 不可用: ' + (e?.message ?? e));
  }
} catch (e) {
  record('fatal', false, e?.message ?? String(e));
} finally {
  finalize();
}
