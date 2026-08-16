#!/usr/bin/env node
/**
 * dsh-sandbox install script (idempotent, repeatable).
 *
 *   node install.mjs [--target <dir>] [--profile <name>] [--uninstall]
 *
 * --target defaults to D:\DeepseekHarness_Test (bridge copy program dir;
 * the production body D:\Deepseek harness must never be touched).
 * The script resolves the target's DSH_HOME from its
 * <target>\DeepSeekHarness-Launcher.cfg `dshHome` key
 * (default D:\DeepseekHarness_Test_Data\.dsh), then wires four steps (all idempotent):
 *
 *   1. bundle row merge: write 'dsh-sandbox' into <DSH_HOME>/profiles/<profile>/package.json
 *      dsh.profile.bundles array + dependencies ('file:' pointing to this package) — same as dsh-github;
 *      this package's cordis.patch.yml insert row (id: test-sandbox, name: dsh-sandbox) is loaded by the bundle mechanism.
 *   2. node_modules links (same as dsh-github's junction pattern):
 *      - junction A: <profile>/node_modules/dsh-sandbox -> this package dir (target -> test workspace);
 *      - dependency fallback: when this package's node_modules is missing, junction it to
 *        <DSH_HOME>/profiles/node_modules (flat fallback for builtin @deepseek-ai/* deps);
 *      - third link = the 'file:' declaration written in step 1 (metadata only, like dsh-github).
 *   3. apiproxy whitelist: add 'sandbox' to the WEB_SETTINGS_NAMESPACES array in
 *      <target>\node_modules\@deepseek-ai\dsh-host-apiproxy\lib\index.js (settings section exposure switch).
 *      Backs up <file>.dsh-sandbox-bak first (never overwrites an existing backup);
 *      skips when 'sandbox' is already in the array.
 *      Running processes are unaffected; takes effect after the bridge copy (3181) restarts.
 *   4. client mount: the client plugin client/client.js is served by DSH's client module system to
 *      /plugins/dsh-sandbox/client.js via package.json dsh.client:{platform:'web'} + exports['./client']
 *      (same approach as dsh-github; served with the bundle, not physically copied).
 *      This step verifies that route is reachable.
 *
 * Uninstall (--uninstall) cleans up in reverse order and preserves other user edits to package.json;
 * the apiproxy whitelist is restored from .dsh-sandbox-bak when present, everything else untouched.
 *
 * @module dsh-sandbox/install
 */
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, readlinkSync, symlinkSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_DIR = dirname(fileURLToPath(import.meta.url))
const PKG_NAME = 'dsh-sandbox'
const APIPROXY_REL = ['node_modules', '@deepseek-ai', 'dsh-host-apiproxy', 'lib', 'index.js']

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(name)
  if (i === -1 || i + 1 >= args.length) return fallback
  const v = args[i + 1]
  return v.startsWith('--') ? fallback : v
}
const UNINSTALL = args.includes('--uninstall')
const TARGET = flag('--target', 'D:\\DeepseekHarness_Test')
const PROFILE = flag('--profile', 'web')

/** Resolve the target's DSH_HOME from its launcher cfg `dshHome` key. */
function targetDshHome(target) {
  try {
    const text = readFileSync(join(target, 'DeepSeekHarness-Launcher.cfg'), 'utf8')
    const line = text.split(/\r?\n/).find((item) => /^\s*dshHome\s*=/.test(item))
    if (line) {
      const value = line.split('=').slice(1).join('=').trim()
      if (value) return value
    }
  } catch { /* fall through to the error below */ }
  throw new Error(`cannot resolve target DSH_HOME: ${TARGET} (missing DeepSeekHarness-Launcher.cfg dshHome key)`)
}

const DSH_HOME = flag('--dsh-home', '') || targetDshHome(TARGET)
const PROFILE_DIR = join(DSH_HOME, 'profiles', PROFILE)
const LINK_PATH = join(PROFILE_DIR, 'node_modules', PKG_NAME)
const FALLBACK_MODULES = join(DSH_HOME, 'profiles', 'node_modules')
const PKG_MODULES = join(PKG_DIR, 'node_modules')
const APIPROXY = join(TARGET, ...APIPROXY_REL)
const APIPROXY_BAK = `${APIPROXY}.dsh-sandbox-bak`
const CLIENT_SRC = join(PKG_DIR, 'client', 'client.js')
const CLIENT_URL = `/plugins/${PKG_NAME}/client.js`

function isLink(p) {
  try { return readlinkSync(p) !== null } catch { return false }
}

/** Idempotently create a junction; when the target is already the same junction -> 'unchanged'. */
function ensureJunction(link, target) {
  if (isLink(link)) {
    try {
      if (readlinkSync(link) === target) return 'unchanged'
    } catch { /* treat as rebuild */ }
    unlinkSync(link)
  } else if (existsSync(link)) {
    throw new Error(`${link} already exists and is not a link (real directory). Move it away manually, then re-run this script.`)
  }
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(target, link, 'junction')
  return 'created'
}

function removeJunctionIfOwned(link, ownedTargets) {
  if (!isLink(link)) return 'skipped'
  let target = null
  try { target = readlinkSync(link) } catch {}
  if (target !== null && ownedTargets.includes(target)) {
    unlinkSync(link)
    return 'removed'
  }
  return 'skipped'
}

/** Step 1: bundle row merge (idempotent): bundles array + dependencies 'file:' declaration. */
function updateManifest() {
  const manifestPath = join(PROFILE_DIR, 'package.json')
  if (!existsSync(manifestPath)) {
    throw new Error(`profile not found or not initialized: ${PROFILE_DIR} (start the bridge copy once with --profile ${PROFILE} first)`)
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const bundles = manifest.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) {
    throw new Error(`${manifestPath} lacks a dsh.profile.bundles array; cannot wire the bundle`)
  }
  manifest.dependencies = manifest.dependencies || {}
  if (UNINSTALL) {
    delete manifest.dependencies[PKG_NAME]
    const i = bundles.indexOf(PKG_NAME)
    if (i >= 0) bundles.splice(i, 1)
  } else {
    manifest.dependencies[PKG_NAME] = 'file:' + PKG_DIR.replace(/\\/g, '/')
    if (!bundles.includes(PKG_NAME)) bundles.push(PKG_NAME)
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  return manifestPath
}

/** Step 3 helper: extract the WEB_SETTINGS_NAMESPACES array block from apiproxy index.js. */
function whitelistBlock(text) {
  const marker = 'const WEB_SETTINGS_NAMESPACES = ['
  const start = text.indexOf(marker)
  if (start === -1) return null
  const close = text.indexOf('];', start)
  if (close === -1) return null
  return { marker, start, close, body: text.slice(start + marker.length, close) }
}

/** Step 3: apiproxy whitelist add 'sandbox' (backup first, idempotent). */
function patchApiproxy() {
  if (!existsSync(APIPROXY)) {
    throw new Error(`apiproxy index.js not found: ${APIPROXY} (confirm --target points at the bridge copy program dir)`)
  }
  const text = readFileSync(APIPROXY, 'utf8')
  const block = whitelistBlock(text)
  if (!block) {
    throw new Error(`cannot find WEB_SETTINGS_NAMESPACES declaration: ${APIPROXY}`)
  }
  if (/"sandbox"|'sandbox'/.test(block.body)) {
    return 'already-present'
  }
  if (!existsSync(APIPROXY_BAK)) {
    copyFileSync(APIPROXY, APIPROXY_BAK)
  }
  const insert = '\n\t"sandbox",'
  const next = text.slice(0, block.start + block.marker.length) + insert + text.slice(block.start + block.marker.length)
  writeFileSync(APIPROXY, next, 'utf8')
  return 'patched'
}

/** Uninstall helper: restore apiproxy from backup when present. */
function restoreApiproxy() {
  if (!existsSync(APIPROXY_BAK)) return 'no-backup'
  copyFileSync(APIPROXY_BAK, APIPROXY)
  return 'restored'
}

/** Step 4: verify the client plugin is servable at /plugins/dsh-sandbox/client.js. */
function verifyClientMount() {
  const pkgPath = join(PKG_DIR, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const platform = pkg.dsh?.client?.platform
  if (platform !== 'web') {
    throw new Error(`${pkgPath} lacks dsh.client.platform:'web'; the client plugin will not load`)
  }
  const clientRel = typeof pkg.exports?.['./client'] === 'string' ? pkg.exports['./client'] : null
  if (!clientRel) {
    throw new Error(`${pkgPath} lacks an exports['./client'] string; the client plugin cannot be served`)
  }
  const clientAbs = resolve(PKG_DIR, clientRel)
  if (clientAbs !== CLIENT_SRC) {
    throw new Error(`exports['./client'] points at ${clientRel}, expected client/client.js (resolved ${clientAbs})`)
  }
  if (!existsSync(CLIENT_SRC)) {
    throw new Error(`client bundle missing: ${CLIENT_SRC}`)
  }
  return CLIENT_URL
}

if (UNINSTALL) {
  console.log(`dsh-sandbox uninstall: target=${TARGET}, profile=${PROFILE}, DSH_HOME=${DSH_HOME}`)
  console.log(' - profile link:', removeJunctionIfOwned(LINK_PATH, [PKG_DIR]))
  console.log(' - package deps link:', removeJunctionIfOwned(PKG_MODULES, [FALLBACK_MODULES]))
  console.log(' - manifest:', updateManifest())
  console.log(' - apiproxy whitelist:', restoreApiproxy(), '->', APIPROXY)
  console.log('')
  console.log('uninstall done. restart the bridge copy (3181) to take effect.')
} else {
  console.log(`dsh-sandbox install: target=${TARGET}, profile=${PROFILE}, DSH_HOME=${DSH_HOME}`)
  console.log(' - step1 profile link (junction A):', ensureJunction(LINK_PATH, PKG_DIR), '->', LINK_PATH)
  let depNote
  if (existsSync(PKG_MODULES)) {
    depNote = 'already-present (skip)'
  } else {
    ensureJunction(PKG_MODULES, FALLBACK_MODULES)
    depNote = 'linked (DSH builtin flat fallback)'
  }
  console.log(' - step2 package deps resolution (junction B):', depNote, '->', PKG_MODULES)
  console.log(' - step3 manifest (bundles + file: dep):', updateManifest())
  console.log(' - step3 apiproxy whitelist:', patchApiproxy(), '->', APIPROXY)
  console.log(' - step4 client mount:', verifyClientMount(), '(served with bundle via dsh.client + exports["/client"])')
  console.log('')
  console.log('install done. next:')
  console.log('  1. restart the bridge copy (3181): cmd /c D:\\DeepseekHarness_Test\\start-test.bat;')
  console.log('  2. settings -> Test Sandbox section appears = wired successfully;')
  console.log('  3. in a new session ask the Agent to call sandbox_list to verify the 9 tools are registered.')
}
