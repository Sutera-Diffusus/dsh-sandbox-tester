#!/usr/bin/env node
/**
 * dsh-sandbox 插件冒烟测试(纯 Node 单元测试,不启动任何 DSH/沙盒进程):
 *   node test/smoke.mjs
 *
 * 覆盖三块(按 CONTRACT §4 与 M4 任务要求):
 *   1. lib/registry.js  —— 临时注册表读写 / 原子性(tmp+rename,无残留) / getSandbox / touchLastRun
 *   2. lib/ports.js     —— isPortFree 探测(占用→false,释放→true)、allocatePort 分配空闲端口与冲突自动 +1
 *   3. lib/merge-gate.js —— 构造坏语法 targets → 必须拒绝;且 dryRun(即使语法通过)不写本体/备份盘
 *
 * 契约说明(CONTRACT §9 契约缺陷兼容):
 *   - registry.js / ports.js 的导出名与签名以 CONTRACT §4 为准,本测试严格按此断言。
 *   - merge-gate.js 实际导出 sandboxMergeTool(services) 工厂(返回带 execute(args, exec) 的工具对象),
 *     services = { registry:{loadRegistry,saveRegistry,getSandbox}, constants:{BODY_PROGRAM_SRC,GUARD_BACKUP_ROOT,SANDBOX_ROOT} };
 *     targets 每项形如 { src: 沙盒源文件, dst: 本体相对路径 }。本测试注入全 fake services(全部落在临时目录,
 *     绝不触碰真实 D:\ai-temp 注册表 / 真实本体 D:\Deepseek harness),按此真实 API 断言。
 *   - merge-gate.js 依赖 @deepseek-ai/dsh-tools(package.json 已声明依赖)。若测试工作区尚未
 *     pnpm install / 建立 node_modules,本段会以 import 失败形式 FAIL 并给出可诊断信息(见结论)。
 *   - 本脚本自身不启动任何进程;merge-gate 内部按 DESIGN §5 对每个待合回 .js 执行 node --check,
 *     这是被测模块的自有行为(本测试仅通过其 execute 触发)。
 *
 * 逐项打印 PASS/FAIL;任一项 FAIL → 退出码 1。
 */
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import net from 'node:net';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
let section = '';
function check(name, ok, detail = '') {
  results.push({ section, name, ok: !!ok, detail: String(detail ?? '') });
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${section}] ${name}${detail ? '  — ' + detail : ''}`);
}

// ── 1. registry ─────────────────────────────────────────────────────────────
async function registryChecks() {
  section = 'registry';
  let mod;
  try {
    mod = await import('../lib/registry.js');
  } catch (e) {
    check('模块可导入(lib/registry.js)', false, 'import 失败: ' + (e?.message ?? e));
    return;
  }
  const { loadRegistry, saveRegistry, getSandbox, touchLastRun } = mod;
  check('导出 loadRegistry/saveRegistry/getSandbox/touchLastRun',
    typeof loadRegistry === 'function' && typeof saveRegistry === 'function'
    && typeof getSandbox === 'function' && typeof touchLastRun === 'function',
    Object.keys(mod).join(', '));

  // REGISTRY_PATH 契约常量(CONTRACT §3);若模块重导出则以其为准
  const REG_PATH = mod.REGISTRY_PATH || 'D:\\ai-temp\\dsh-sandbox-registry.json';
  const dir = dirname(REG_PATH);
  const base = basename(REG_PATH);

  // 快照 + 恢复:测试读写真实注册表路径(D:\ai-temp,允许写入),结束恢复原状
  const existed = existsSync(REG_PATH);
  const before = existed ? readFileSync(REG_PATH, 'utf8') : null;
  try {
    // 文件不存在分支
    rmSync(REG_PATH, { force: true });
    const emptyOnMissing = await loadRegistry();
    check('loadRegistry 文件不存在返回 {sandboxes:{}}',
      emptyOnMissing && typeof emptyOnMissing === 'object'
      && typeof emptyOnMissing.sandboxes === 'object' && Object.keys(emptyOnMissing.sandboxes).length === 0,
      JSON.stringify(emptyOnMissing)?.slice(0, 80));

    // 读写 roundtrip
    const reg = {
      sandboxes: {
        smoke1: { name: 'smoke1', port: 3199, status: 'stopped', createdAt: new Date().toISOString() },
      },
    };
    await saveRegistry(reg);
    const loaded = await loadRegistry();
    check('saveRegistry→loadRegistry 读写 roundtrip',
      loaded?.sandboxes?.smoke1?.name === 'smoke1' && loaded?.sandboxes?.smoke1?.port === 3199,
      JSON.stringify(loaded?.sandboxes)?.slice(0, 120));

    // 原子性:写盘为完整合法 JSON,且无残留 tmp 文件(tmp+rename 清理)
    let parsedOk = true;
    try { JSON.parse(readFileSync(REG_PATH, 'utf8')); } catch { parsedOk = false; }
    check('写盘为完整合法 JSON(原子写,非半截)', parsedOk, '');
    const leftovers = readdirSync(dir).filter((n) => n !== base && n.startsWith(base) && /tmp|part|swp|\.\d+$/i.test(n));
    check('原子写无残留 tmp 文件', leftovers.length === 0, leftovers.join(', ') || '无');

    // getSandbox
    const hit = await getSandbox(loaded, 'smoke1');
    check('getSandbox 命中返回记录', hit && hit.name === 'smoke1', JSON.stringify(hit)?.slice(0, 80));
    const miss = await getSandbox(loaded, 'no-such');
    check('getSandbox 未命中返回 undefined', miss === undefined || miss === null, String(miss));

    // touchLastRun
    await touchLastRun(loaded, 'smoke1');
    check('touchLastRun 更新 lastRunAt', typeof loaded?.sandboxes?.smoke1?.lastRunAt === 'string',
      String(loaded?.sandboxes?.smoke1?.lastRunAt));
  } finally {
    if (existed) writeFileSync(REG_PATH, before, 'utf8');
    else rmSync(REG_PATH, { force: true });
  }
}

// ── 2. ports ────────────────────────────────────────────────────────────────
async function portsChecks() {
  section = 'ports';
  let mod;
  try {
    mod = await import('../lib/ports.js');
  } catch (e) {
    check('模块可导入(lib/ports.js)', false, 'import 失败: ' + (e?.message ?? e));
    return;
  }
  const { allocatePort, isPortFree } = mod;
  check('导出 allocatePort/isPortFree',
    typeof allocatePort === 'function' && typeof isPortFree === 'function',
    Object.keys(mod).join(', '));

  // isPortFree:本机临时起一个监听,探测应为"占用"
  const srv = net.createServer();
  await new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', resolve);
  });
  const occupiedPort = srv.address().port;
  const busy = await isPortFree(occupiedPort);
  check('isPortFree 已监听端口返回 false', busy === false, `port=${occupiedPort} → ${busy}`);

  await new Promise((resolve) => srv.close(resolve));
  await delay(80);
  const free = await isPortFree(occupiedPort);
  check('isPortFree 已释放端口返回 true', free === true, `port=${occupiedPort} → ${free}`);

  // allocatePort 基本行为
  const p = await allocatePort(40000);
  check('allocatePort 返回整数且 >= 起点', Number.isInteger(p) && p >= 40000, `p=${p}`);
  const pFree = await isPortFree(p);
  check('allocatePort 分配出的端口空闲', pFree === true, `p=${p} → ${pFree}`);

  // 冲突自动 +1
  const srv2 = net.createServer();
  await new Promise((resolve, reject) => {
    srv2.once('error', reject);
    srv2.listen(40100, '127.0.0.1', resolve);
  });
  try {
    const p2 = await allocatePort(40100);
    check('allocatePort 起点被占用时自动 +1(跳过占用)', Number.isInteger(p2) && p2 > 40100, `p2=${p2}`);
    const p2Free = await isPortFree(p2);
    check('冲突后分配出的端口空闲', p2Free === true, `p2=${p2} → ${p2Free}`);
  } finally {
    await new Promise((resolve) => srv2.close(resolve));
  }
}

// ── 3. merge-gate ───────────────────────────────────────────────────────────
function snapshotTree(dir) {
  const out = {};
  if (!existsSync(dir)) return out;
  (function walk(d) {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else out[p] = readFileSync(p, 'utf8');
    }
  })(dir);
  return out;
}
function treesEqual(a, b) {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.join('\n') !== kb.join('\n')) return false;
  return ka.every((k) => a[k] === b[k]);
}
// 读取注册表沙盒记录(供 getSandbox 断言)
function readReg(regFile) {
  return existsSync(regFile) ? JSON.parse(readFileSync(regFile, 'utf8')) : { sandboxes: {} };
}

async function mergeGateChecks() {
  section = 'merge-gate';
  let mod;
  try {
    mod = await import('../lib/merge-gate.js');
  } catch (e) {
    check('模块可导入(lib/merge-gate.js)', false, 'import 失败: ' + (e?.message ?? e));
    return;
  }
  const { sandboxMergeTool } = mod;
  check('导出 sandboxMergeTool', typeof sandboxMergeTool === 'function', Object.keys(mod).join(', '));
  if (typeof sandboxMergeTool !== 'function') return;

  const tmp = mkdtempSync(join(tmpdir(), 'dsh-sandbox-smoke-'));
  try {
    const bodyRoot = join(tmp, 'body');        // 模拟本体根(仅用于观察是否被写)
    const backupRoot = join(tmp, 'backup');    // 模拟备份根
    const sandboxRoot = join(tmp, 'sandboxes');
    const regFile = join(tmp, 'registry.json');
    const programDir = join(sandboxRoot, 'qa-smoke', 'program');
    mkdirSync(programDir, { recursive: true });

    // 全 fake services:落在临时目录,绝不触碰真实注册表/本体
    const fakeRegistry = {
      async loadRegistry() { return readReg(regFile); },
      async saveRegistry(reg) { writeFileSync(regFile, JSON.stringify(reg, null, 2), 'utf8'); },
      getSandbox(reg, name) { return reg?.sandboxes?.[name] ?? undefined; },
    };
    const fakeConstants = { BODY_PROGRAM_SRC: bodyRoot, GUARD_BACKUP_ROOT: backupRoot, SANDBOX_ROOT: sandboxRoot };

    // 注册沙盒 qa-smoke
    const reg = await fakeRegistry.loadRegistry();
    reg.sandboxes['qa-smoke'] = { name: 'qa-smoke', programDir, status: 'stopped' };
    await fakeRegistry.saveRegistry(reg);

    const tool = sandboxMergeTool({ registry: fakeRegistry, constants: fakeConstants });
    check('sandboxMergeTool 返回带 execute 的工具对象', tool && typeof tool.execute === 'function',
      `execute=${typeof tool?.execute}`);

    const dst = 'node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js'; // 本体相对路径(temp body 下为"新增文件",过白名单)
    const dstAbs = join(bodyRoot, ...dst.split('/'));

    // 场景 A:坏语法 targets → 必须拒绝,且 dryRun 不写本体/备份
    const badJs = join(programDir, 'bad.js');
    writeFileSync(badJs, 'function broken( {{{ ;;; not valid javascript', 'utf8');
    const beforeA = { body: snapshotTree(bodyRoot), backup: snapshotTree(backupRoot) };
    let resultA = null;
    let threwA = null;
    try {
      resultA = await tool.execute({ name: 'qa-smoke', targets: [{ src: badJs, dst }], dryRun: true }, {});
    } catch (e) { threwA = e; }
    const rejectedA = threwA !== null || (resultA && resultA.ok === false);
    check('坏语法 targets 必须拒绝(ok=false 或抛错)', rejectedA === true,
      threwA ? 'throw: ' + (threwA?.message ?? String(threwA)) : `ok=${resultA?.ok} ${resultA?.message ?? ''}`);
    check('坏语法被拒后 dryRun 不写本体', treesEqual(beforeA.body, snapshotTree(bodyRoot)),
      `body 文件数 before=${Object.keys(beforeA.body).length} after=${Object.keys(snapshotTree(bodyRoot)).length}`);
    check('坏语法被拒后 dryRun 不写备份盘', treesEqual(beforeA.backup, snapshotTree(backupRoot)),
      `backup 文件数 before=${Object.keys(beforeA.backup).length} after=${Object.keys(snapshotTree(backupRoot)).length}`);

    // 场景 B:好语法 targets + dryRun=true → 门禁通过,但绝不写本体/备份盘(dryRun 语义核心)
    const goodJs = join(programDir, 'good.js');
    writeFileSync(goodJs, 'console.log("ok");\n', 'utf8');
    const beforeB = { body: snapshotTree(bodyRoot), backup: snapshotTree(backupRoot) };
    let resultB = null;
    let threwB = null;
    try {
      resultB = await tool.execute({ name: 'qa-smoke', targets: [{ src: goodJs, dst }], dryRun: true }, {});
    } catch (e) { threwB = e; }
    check('好语法 targets + dryRun 门禁通过', threwB === null && resultB && resultB.ok === true,
      threwB ? 'throw: ' + (threwB?.message ?? String(threwB)) : `ok=${resultB?.ok} ${resultB?.message ?? ''}`);
    check('好语法 + dryRun 不写本体(dst 未落盘)', !existsSync(dstAbs), dstAbs);
    check('好语法 + dryRun 不写备份盘(backup 未创建)', !existsSync(backupRoot)
      || readdirSync(backupRoot).length === 0, backupRoot);
    check('dryRun 后目录内容整体不变(排除注册表报告)', treesEqual(beforeB.body, snapshotTree(bodyRoot))
      && treesEqual(beforeB.backup, snapshotTree(backupRoot)), 'body/backup 与执行前一致');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── 汇总 ────────────────────────────────────────────────────────────────────
try {
  await registryChecks();
  await portsChecks();
  await mergeGateChecks();
} catch (e) {
  check('smoke 执行未抛异常', false, (e?.stack ?? e?.message ?? String(e)));
}

const fails = results.filter((r) => !r.ok);
console.log(`\nSMOKE 汇总: ${results.length - fails.length}/${results.length} 通过`);
if (fails.length) {
  console.log('失败项:');
  for (const f of fails) console.log(`  - [${f.section}] ${f.name}${f.detail ? ' — ' + f.detail : ''}`);
  process.exitCode = 1;
} else {
  console.log('SMOKE PASSED');
}
