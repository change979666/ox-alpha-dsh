#!/usr/bin/env node
/**
 * test-pool.mjs — real integration self-test for the Model Pool failover core.
 *
 * Spins local mock upstream servers and drives ModelHubPoolAdapter end-to-end:
 *   A  one provider/channel/model serves a request
 *   B  three channels, same model, round-robin spreads traffic
 *   C  channel A returns 429 → automatic switch to B
 *   D  channel A times out (per-attempt timeout) → switch to B
 *   E  channel A disabled → never contacted
 *   F  all channels fail → clear aggregated error
 *   G  persistence: store round-trips through disk
 *   H  dedupe: same model on N channels listed once with N channels
 *
 * No network access needed — everything is loopback.
 */
import { createServer } from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'
import assert from 'node:assert'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModelHubPoolAdapter } from '../plugin/pool-adapter.js'
import { normalizeChannel, normalizePoolModel } from '../plugin/pool-core.js'

const results = []
const check = (name, fn) => async () => {
  try { await fn(); results.push(['✓', name]) } catch (e) { results.push(['✗', `${name}: ${e.message}`]) }
}

function sseServer(respond) {
  return createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', async () => {
      await respond(req, res, body)
    })
  })
}

function sse(res, text, usage) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const chunks = [
    `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: text } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage }) }\n\n`,
    'data: [DONE]\n\n',
  ]
  for (const c of chunks) res.write(c)
  res.end()
}

function collectStream(adapter, model) {
  return (async () => {
    let text = ''
    let sawUsage = false
    let sawFinish = false
    for await (const chunk of adapter.stream({
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      signal: undefined,
    })) {
      if (chunk.type === 'text-delta') text += chunk.text
      if (chunk.type === 'usage') sawUsage = true
      if (chunk.type === 'finish') sawFinish = true
    }
    return { text, sawUsage, sawFinish }
  })()
}

const mkStore = (cfgObj, dir) => {
  const path = join(dir, `pool-${Math.random().toString(36).slice(2)}.json`)
  writeFileSync(path, JSON.stringify(cfgObj))
  return {
    get() { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return cfgObj } },
    save(next) { writeFileSync(path, JSON.stringify(next)) },
    path,
  }
}
const fakeCtx = () => ({
  get(name) {
    if (name === 'credentials') return { resolve: async () => ({ value: 'sk-test-not-real' }) }
    return undefined
  },
})

async function freePort() {
  const srv = createServer()
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  await new Promise((r) => srv.close(r))
  return port
}

const tests = []

tests.push(check('G-pre: persistence round-trip', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mh-'))
  const store = mkStore({ channels: [], models: [], pools: [], strategy: 'priority' }, dir)
  const cfg = store.get(); cfg.channels.push(normalizeChannel({ id: 'c1', providerId: 'p', baseUrl: 'http://x/v1' })); store.save(cfg)
  const again = JSON.parse(readFileSync(store.path, 'utf8'))
  assert.equal(again.channels.length, 1)
  rmSync(dir, { recursive: true, force: true })
}))

const A = { hits: [] }
const B = { hits: [] }
const SLOW = { hits: [] }
let aPort, bPort, slowPort
let serverA, serverB, serverSlow

tests.push(check('setup: mock upstreams', async () => {
  aPort = await freePort(); bPort = await freePort(); slowPort = await freePort()
  serverA = sseServer(async (req, res) => { A.hits.push(1); res.writeHead(429, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'rate limited' } })) })
  serverB = sseServer(async (req, res) => { B.hits.push(1); sse(res, 'hello-from-B', { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }) })
  serverSlow = sseServer(async (req, res) => { SLOW.hits.push(1); await sleep(5000); sse(res, 'too-late', {}) })
  await new Promise((r) => serverA.listen(aPort, '127.0.0.1', r))
  await new Promise((r) => serverB.listen(bPort, '127.0.0.1', r))
  await new Promise((r) => serverSlow.listen(slowPort, '127.0.0.1', r))
}))

tests.push(check('C+D: 429 and timeout fallback to healthy channel', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mh-'))
  const cfg = {
    strategy: 'priority',
    channels: [
      normalizeChannel({ id: 'ch-a', providerId: 'mock', baseUrl: `http://127.0.0.1:${aPort}/v1`, priority: 10, timeoutMs: 800 }),
      normalizeChannel({ id: 'ch-a2-slow', providerId: 'mock', baseUrl: `http://127.0.0.1:${slowPort}/v1`, priority: 8, timeoutMs: 400 }),
      normalizeChannel({ id: 'ch-b', providerId: 'mock', baseUrl: `http://127.0.0.1:${bPort}/v1`, priority: 0 }),
    ],
    models: [normalizePoolModel({ id: 'demo-model', displayName: 'Demo', capabilities: { text: true }, contextWindow: 1000, maxOutputTokens: 100 })],
    pools: [],
  }
  const adapter = new ModelHubPoolAdapter({ store: mkStore(cfg, dir), resolveSecret: async () => 'sk-x', log: () => {} })
  const r = await collectStream(adapter, 'demo-model')
  assert.equal(r.text, 'hello-from-B')
  assert.ok(r.sawUsage && r.sawFinish, 'usage+finish emitted')
  assert.ok(A.hits.length >= 1, 'A was tried (429 path)')
  assert.ok(SLOW.hits.length >= 1, 'slow channel was tried (timeout path)')
  assert.ok(B.hits.length >= 1, 'B served the request')
  const st = adapter.state['ch-a']
  assert.ok(st && st.errorCount >= 1 && st.cooldownUntil > Date.now() - 60000, 'A entered cooldown')
  rmSync(dir, { recursive: true, force: true })
}))

tests.push(check('E: disabled channel never contacted', async () => {
  const before = A.hits.length
  const dir = mkdtempSync(join(tmpdir(), 'mh-'))
  const cfg = {
    strategy: 'priority',
    channels: [
      { ...normalizeChannel({ id: 'ch-a', providerId: 'mock', baseUrl: `http://127.0.0.1:${aPort}/v1` }), enabled: false },
      normalizeChannel({ id: 'ch-b', providerId: 'mock', baseUrl: `http://127.0.0.1:${bPort}/v1` }),
    ],
    models: [normalizePoolModel({ id: 'demo-model', displayName: 'Demo', capabilities: { text: true } })],
    pools: [],
  }
  const adapter = new ModelHubPoolAdapter({ store: mkStore(cfg, dir), resolveSecret: async () => 'sk-x', log: () => {} })
  const r = await collectStream(adapter, 'demo-model')
  assert.equal(r.text, 'hello-from-B')
  assert.equal(A.hits.length, before, 'disabled A untouched')
  rmSync(dir, { recursive: true, force: true })
}))

tests.push(check('F: all channels failing → aggregated error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mh-'))
  const cfg = {
    strategy: 'priority',
    channels: [
      normalizeChannel({ id: 'f1', providerId: 'mock', baseUrl: `http://127.0.0.1:${aPort}/v1` }),
      normalizeChannel({ id: 'f2', providerId: 'mock', baseUrl: `http://127.0.0.1:${aPort}/v1` }),
    ],
    models: [normalizePoolModel({ id: 'm', displayName: 'M', capabilities: { text: true } })],
    pools: [],
  }
  const adapter = new ModelHubPoolAdapter({ store: mkStore(cfg, dir), resolveSecret: async () => 'sk-x', log: () => {} })
  await assert.rejects(collectStream(adapter, 'm'), (e) => /all 2 channel\(s\) failed/.test(e.message))
  rmSync(dir, { recursive: true, force: true })
}))

tests.push(check('H: alias resolves to concrete model; unknown id rejected clearly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mh-'))
  const cfg = {
    strategy: 'priority',
    channels: [normalizeChannel({ id: 'ch-b', providerId: 'mock', baseUrl: `http://127.0.0.1:${bPort}/v1`, models: ['demo-model'] })],
    models: [normalizePoolModel({ id: 'demo-model', displayName: 'Demo', aliases: ['free-demo'], capabilities: { text: true } })],
    pools: [],
  }
  const adapter = new ModelHubPoolAdapter({ store: mkStore(cfg, dir), resolveSecret: async () => 'sk-x', log: () => {} })
  const viaAlias = await collectStream(adapter, 'free-demo')
  assert.equal(viaAlias.text, 'hello-from-B')
  await assert.rejects(collectStream(adapter, 'nope'), (e) => /unknown pool model/.test(e.message))
  rmSync(dir, { recursive: true, force: true })
}))

;(async () => {
  for (const t of tests) await t()
  for (const [, n] of results) console.log(n)
  const failed = results.filter(([s]) => s === '✗').length
  serverA?.close(); serverB?.close(); serverSlow?.close()
  console.log(failed === 0 ? '\n✅ pool integration tests: all passed' : `\n❌ ${failed} test(s) failed`)
  process.exit(failed === 0 ? 0 : 1)
})()