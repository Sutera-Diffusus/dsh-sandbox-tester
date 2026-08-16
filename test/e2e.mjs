// test/e2e.mjs — dsh-sandbox end-to-end adversarial validation (pure ASCII on purpose)
// Flow: precheck body -> create sandbox -> boot -> health -> adversarial kill
//       -> inject bad patch -> boot must fail -> body still intact -> destroy -> report
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const { sandbox_create, sandbox_inject, sandbox_destroy } = await import('../lib/tools-lifecycle.js')
const { loadRegistry } = await import('../lib/registry.js')
const { startSandbox, stopSandbox, sandboxAlive, body3080Owner } = await import('../lib/proctree.js')

const BODY_URL = 'http://127.0.0.1:3080/'
const NAME = `e2e-${Date.now().toString(36)}`
const results = []
const step = (label, ok, detail = '') => { results.push({ label, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -- ' + detail : ''}`) }

async function httpGet(url, timeoutMs = 5000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    return res.status
  } catch { return 0 }
}
async function poll(url, ms, interval = 2000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if ((await httpGet(url)) === 200) return true
    await new Promise((r) => setTimeout(r, interval))
  }
  return false
}

// ── 0. body precheck baseline ──────────────────────────────────────────────
const owner0 = await body3080Owner()
const bodyOk0 = (await httpGet(BODY_URL)) === 200
console.log(`[baseline] 3080 owner=${owner0} http=${bodyOk0 ? 200 : 'FAIL'}`)
if (!bodyOk0 || owner0 == null) { console.error('BODY BASELINE FAILED; aborting'); process.exit(1) }

let record = null
try {
  // ── 1. create (trim copy of body node_modules) ────────────────────────────
  const created = await sandbox_create({ name: NAME, basePort: 3390 })
  step('sandbox_create ok', created.ok === true, `port=${created.port} mode=${created.copyMode} skipped=${created.skippedLockedFiles}`)

  // minimal clean profile for the sandbox home (no dsh-github dependency)
  const profileDir = join(created.home, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web-sandbox', private: true, dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }, null, 2) + '\n')
  step('sandbox home profile seeded', existsSync(join(profileDir, 'package.json')))

  // ── 2. boot sandbox ───────────────────────────────────────────────────────
  const reg = await loadRegistry()
  record = reg.sandboxes[NAME]
  const pid = await startSandbox(record)
  record.pid = pid // pid write-back is sandbox_run's job; mirror it here for sandboxAlive
  step('startSandbox spawned', Number.isInteger(pid) && pid > 0, `pid=${pid}`)
  const up = await poll(`http://127.0.0.1:${record.port}/`, 90000)
  step('sandbox HTTP 200', up, `port=${record.port}`)
  const alive = await sandboxAlive(record)
  step('sandboxAlive true', alive === true)

  // ── 3. adversarial A: hard-kill sandbox (simulate crash) ──────────────────
  const { execFileSync } = await import('node:child_process')
  execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  await new Promise((r) => setTimeout(r, 2500))
  const ownerAfterKill = await body3080Owner()
  const bodyOkAfterKill = (await httpGet(BODY_URL)) === 200
  step('body intact after sandbox kill', ownerAfterKill === owner0 && bodyOkAfterKill, `owner ${owner0}->${ownerAfterKill}, http ${bodyOkAfterKill ? 200 : 'FAIL'}`)

  // ── 4. adversarial B: inject bad patch, boot must fail (contained) ────────
  const injected = await sandbox_inject({
    name: NAME,
    patch: { files: [{ path: 'node_modules/@deepseek-ai/dsh-base/cordis.patch.yml', content: 'broken: [yaml: : :' }] },
  })
  step('sandbox_inject bad patch', injected && injected.ok === true, injected && injected.files ? `files=${injected.files}` : '')
  const pid2 = await startSandbox(record)
  if (Number.isInteger(pid2) && pid2 > 0) record.pid = pid2
  await new Promise((r) => setTimeout(r, 6000))
  const sandboxUp2 = await httpGet(`http://127.0.0.1:${record.port}/`)
  step('sandbox with bad patch failed to come up', pid2 === null || sandboxUp2 !== 200, `http=${sandboxUp2}`)
  const ownerAfterBad = await body3080Owner()
  const bodyOkAfterBad = (await httpGet(BODY_URL)) === 200
  step('body intact after sandbox boot failure', ownerAfterBad === owner0 && bodyOkAfterBad, `owner ${owner0}->${ownerAfterBad}, http ${bodyOkAfterBad ? 200 : 'FAIL'}`)

  // ── 5. destroy ────────────────────────────────────────────────────────────
  const destroyed = await sandbox_destroy({ name: NAME, confirm: true })
  step('sandbox_destroy ok', destroyed && destroyed.ok === true)
  const reg2 = await loadRegistry()
  step('registry entry removed', !reg2.sandboxes[NAME])
  step('sandbox dir removed', !existsSync(join('D:\\DeepseekHarness_Sandboxes', NAME)))

  // ── 6. final body recheck ─────────────────────────────────────────────────
  const ownerFinal = await body3080Owner()
  const bodyOkFinal = (await httpGet(BODY_URL)) === 200
  step('body intact at end', ownerFinal === owner0 && bodyOkFinal, `owner ${owner0}->${ownerFinal}, http ${bodyOkFinal ? 200 : 'FAIL'}`)
} catch (e) {
  step('unexpected exception', false, e && e.stack ? e.stack.split('\n')[0] + ' ' + (e.stack.split('\n')[1] || '') : String(e))
  // best-effort cleanup
  try { await sandbox_destroy({ name: NAME, confirm: true }) } catch {}
  try { const rec = (await loadRegistry()).sandboxes[NAME]; if (rec) await stopSandbox(rec) } catch {}
}

const failed = results.filter((r) => !r.ok)
console.log(`\nE2E SUMMARY: ${results.length - failed.length}/${results.length} passed`)
console.log(JSON.stringify(results, null, 1))
process.exit(failed.length === 0 ? 0 : 1)
