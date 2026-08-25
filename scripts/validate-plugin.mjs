#!/usr/bin/env node
/**
 * validate-plugin.mjs — minimal repeatable self-check for the ox-alpha-dsh
 * bundle, mirroring the awesome-dsh-plugin contributing requirements.
 *
 *   npm run check
 *
 * Checks (each failure exits 1 with a named reason):
 *  1. package.json exists and parses
 *  2. dsh.bundle manifest present (patch entry)
 *  3. cordis.patch.yml exists
 *  4. patch file points at a real file
 *  5. bundle plugin entry (main) exists and parses as ESM (export name/apply)
 *  6. registry JSON files parse
 *  7. no obvious secrets in tracked source (key patterns / .env etc.)
 *  8. README install command matches the actual add command shape
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const failures = []
const ok = (m) => console.log('  ✓ ' + m)
const bad = (m) => { console.error('  ✗ ' + m); failures.push(m) }

function read(p) { return readFileSync(p, 'utf8') }

/* 1. package.json */
const pkgPath = join(root, 'package.json')
if (!existsSync(pkgPath)) { bad('package.json missing'); process.exit(1) }
let pkg
try { pkg = JSON.parse(read(pkgPath)); ok('package.json parses') } catch (e) { bad('package.json invalid: ' + e.message); process.exit(1) }

/* 2. dsh.bundle */
const bundle = pkg && pkg.dsh && pkg.dsh.bundle
if (!bundle || typeof bundle !== 'object') bad('dsh.bundle manifest missing (required by awesome-dsh-plugin)')
else {
  ok('dsh.bundle present')
  if (!bundle.patch || typeof bundle.patch !== 'string') bad('dsh.bundle.patch missing (must point at cordis.patch.yml)')
}

/* 3. cordis.patch.yml */
const patchYml = join(root, 'cordis.patch.yml')
if (!existsSync(patchYml)) bad('cordis.patch.yml missing')
else ok('cordis.patch.yml present')

/* 4. patch reference resolves */
if (bundle && bundle.patch) {
  const target = resolve(root, bundle.patch)
  if (!existsSync(target)) bad(`dsh.bundle.patch → ${bundle.patch} does not resolve`)
  else ok(`dsh.bundle.patch resolves (${target})`)
}

/* 5. plugin entry */
const mainRel = pkg && typeof pkg.main === 'string' ? pkg.main : 'plugin/index.js'
const mainPath = resolve(root, mainRel)
if (!existsSync(mainPath)) bad(`plugin entry ${mainRel} missing`)
else {
  ok(`plugin entry present (${mainRel})`)
  const text = read(mainPath)
  if (!/export\s+const\s+name\s*=|export\s+function\s+apply\s*\(/.test(text)) {
    bad('plugin entry must export name and apply (ESM plugin module)')
  } else {
    ok('plugin entry exports name + apply')
    const chk = spawnSync(process.execPath, ['--check', mainPath], { encoding: 'utf8' })
    if (chk.status !== 0) bad('plugin entry fails syntax check: ' + (chk.stderr || '').trim())
    else ok('plugin entry parses as JS')
  }
}

/* 6. registry JSON */
const registryDirs = [join(root, 'registry'), join(root, 'registry', 'models'), join(root, 'registry', 'providers')]
let jsonCount = 0
for (const dir of registryDirs) {
  if (!existsSync(dir)) continue
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue
    const p = join(dir, f)
    try { JSON.parse(read(p)); jsonCount++ } catch (e) { bad(`registry JSON invalid (${join(dir, f)}): ${e.message}`) }
  }
}
if (jsonCount === 0) bad('no registry JSON files found')
else ok(`registry JSON files parse (${jsonCount})`)

/* 7. secret scan on tracked source */
const secretPatterns = [
  /ghp_[A-Za-z0-9]{30,}/,
  /sk-(?:or-|proj-)?[A-Za-z0-9]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /"type"\s*:\s*"service_account"/,
]
const scanFiles = []
function walkDir(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (existsSync(p)) {
      if (f.endsWith('.json') || f.endsWith('.md') || f.endsWith('.js')) scanFiles.push(p)
      else {
        try { if (readdirSync(p)) walkDir(p) } catch { /* file, skip */ }
      }
    }
  }
}
for (const rel of ['plugin', 'registry', 'docs']) {
  const dir = join(root, rel)
  if (existsSync(dir)) walkDir(dir)
}
for (const rel of ['README.md', mainRel]) {
  const p = join(root, rel)
  if (existsSync(p)) scanFiles.push(p)
}
let secretHits = 0
for (const f of scanFiles) {
  try {
    const text = read(f)
    for (const re of secretPatterns) {
      if (re.test(text)) { bad(`possible secret pattern in ${f} (${re})`); secretHits++; break }
    }
  } catch {}
}
if (secretHits === 0) ok('no obvious secret patterns in source/registry/docs/README')

/* 8. README install command consistency */
const readmePath = join(root, 'README.md')
if (existsSync(readmePath)) {
  const readme = read(readmePath)
  if (/dsh\s+plugin\s+(--profile\s+\S+\s+)?add\s+/i.test(readme)) ok('README documents `dsh plugin add` install')
  else bad('README missing `dsh plugin add` install command')
} else {
  bad('README.md missing')
}

/* summary */
console.log(failures.length === 0 ? '\n✅ validate-plugin: all checks passed' : `\n❌ validate-plugin: ${failures.length} check(s) failed`)
process.exitCode = failures.length === 0 ? 0 : 1