/**
 * Model Hub for DSH 🔌 — official bundle entry (ESM plugin module)
 * =============================================================================
 * This is the entry installed by `dsh plugin add` via cordis.patch.yml.
 * It is a standard DSH/Cordis plugin module:
 *
 *   export const name  — plugin identity
 *   export function apply(ctx) — the plugin body
 *
 * Pipeline:
 *   model/provider definitions (friendly JSON schema)
 *     → normalize (teaching errors, whitelist, id/name separation)
 *     → pi-ai provider profiles (merge-preserve, never overwrites user models)
 *     → ctx.settings.update('llm-pi-ai', patch)   [official seam: live+durable]
 *
 * Tools registered through ctx.tools.register:
 *   model_status       health report: route / api key / per-model facts
 *   model_hub_manage   install | remove <route> | reset-route <route> | list
 *   model_import       install one model definition from a JSON string
 *   model_discover     search OpenRouter's public /models catalog
 *
 * Settings safety contract (see README § 权限与数据访问):
 *   - incremental deep-merge patches only; never replaces providers wholesale
 *   - touches only routes this plugin manages
 *   - user-added models on a shared route are preserved, never cleared
 *   - remove deletes only plugin-managed routes / definitions it installed
 *   - reset-route restores this plugin's definitions without touching user models
 *
 * Security: this plugin NEVER reads API key values. It only writes the
 * *reference* name (apiKeyEnv) into settings and asks the credentials service
 * whether a reference is configured (boolean). Keys are pasted by the user in
 * the GUI. model_discover talks only to OpenRouter's public /models endpoint.
 *
 * No dependencies, no build step — source is the artifact.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join as joinPath } from 'node:path'
import { ModelHubPoolAdapter, POOL_ROUTE, streamAttempt } from './pool-adapter.js'
import { normalizeChannel, normalizePoolModel, resolveRequest, orderChannels, STRATEGIES as POOL_STRATEGIES } from './pool-core.js'

/* ── ⚙️ optional overrides directory (absolute path). Keep '' to disable. ──
 * Drop *.json files there: {"kind":"provider",…} defines a provider,
 * anything else with provider+id defines a model. Re-run install to apply. */
const OVERRIDES_DIR = ''

/** Wire protocol names this build of pi-ai can serve for hand-declared routes. */
const PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages']

/** Modalities supported by this DSH build (audio/video are NOT wired yet). */
const MODALITIES = ['text', 'image']

/** Thinking levels understood by pi-ai dispatch, escalation order. */
const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** compat fields offered on openai-completions routes (withheld ones rejected). */
const COMPAT_OFFERED = [
  'supportsStore', 'supportsDeveloperRole', 'supportsReasoningEffort',
  'supportsUsageInStreaming', 'maxTokensField', 'requiresToolResultName',
  'requiresAssistantAfterToolResult', 'requiresThinkingAsText',
  'requiresReasoningContentOnAssistantMessages', 'thinkingFormat',
  'chatTemplateKwargs', 'supportsStrictMode', 'cacheControlFormat',
  'supportsLongCacheRetention',
]
const THINKING_FORMATS = ['openai', 'deepseek', 'openrouter', 'together', 'zai', 'qwen', 'chat-template', 'qwen-chat-template', 'string-thinking', 'ant-ling']
const TOKEN_FIELDS = ['max_completion_tokens', 'max_tokens']

/** Built-in provider presets (catalog routes: zero-config beyond the key). */
const PROVIDER_PRESETS = {
  openrouter: {
    catalog: true, // pi-ai ships baseUrl + openai-completions implementation
    displayName: 'OpenRouter',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    api: 'openai-completions',
    baseUrl: 'https://openrouter.ai/api/v1',
    homepage: 'https://openrouter.ai/keys',
  },
}

/** Safe default reasoning map when a definition just says reasoning: true. */
const DEFAULT_EFFORTS = { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' }

/** Built-in model definitions. Source of truth mirrored in registry/models/. */
const BUILTIN_MODELS = [
  {
    provider: 'openrouter',
    id: 'stealth/ox-alpha',
    name: 'Ox Alpha',
    contextWindow: 1048576,
    maxTokens: 131072,
    input: ['text', 'image'],
    reasoning: true,
    tools: true,
    notes: 'anonymous stealth provider; free promo pricing at publish time; prompts retained by provider (see README privacy note)',
  },
]

/* ═══════════════════════════ helpers ═══════════════════════════ */

function fail(msg) { throw new Error('[model-hub] ' + msg) }
function isStr(v) { return typeof v === 'string' && v.length > 0 }

function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'alias'
}

/**
 * Rebuild plain objects with NULL prototypes. Needed only for the dynamic
 * (cordis_define) variant of this plugin, which runs in an isolated realm
 * whose plain objects fail the settings service' cross-realm guard. In the
 * bundle form this is a no-op safety; objects with proto===null are legal
 * everywhere in the settings pipeline, so the same code works in both forms.
 */
function deepPlain(value) {
  if (Array.isArray(value)) return value.map(deepPlain)
  if (value !== null && typeof value === 'object') {
    const out = Object.create(null)
    for (const key of Object.keys(value)) out[key] = deepPlain(value[key])
    return out
  }
  return value
}

/* ═══════════════════════ definition normalization ═══════════════════════ */

const MODEL_KEYS = ['provider', 'id', 'name', 'aliases', 'contextWindow', 'maxTokens', 'input', 'reasoning', 'tools', 'compat', 'notes']

/** Friendly definition → pi-ai model entry (+ display metadata). */
function normalizeModel(def) {
  if (def === null || typeof def !== 'object' || Array.isArray(def)) fail('model definition must be an object')
  for (const key of Object.keys(def)) {
    if (!MODEL_KEYS.includes(key)) {
      fail(`model "${def.id || '?'}": unknown field "${key}". Allowed: ${MODEL_KEYS.join(', ')}`)
    }
  }
  if (!isStr(def.provider)) fail('model definition needs "provider" (a built-in preset like "openrouter", or a custom provider id you defined first)')
  if (!isStr(def.id)) fail('model definition needs "id" — the exact model id sent to the API (not the display name)')
  const name = isStr(def.name) ? def.name : def.id // name ≠ id: UI label vs wire id
  const entry = {}
  entry.id = def.id
  entry.name = name
  if (def.contextWindow !== undefined) {
    if (!Number.isInteger(def.contextWindow) || def.contextWindow <= 0) fail(`"${def.id}": contextWindow must be a positive integer`)
    entry.contextWindow = def.contextWindow
  }
  if (def.maxTokens !== undefined) {
    if (!Number.isInteger(def.maxTokens) || def.maxTokens <= 0) fail(`"${def.id}": maxTokens must be a positive integer`)
    entry.maxTokens = def.maxTokens
  }
  if (def.input !== undefined) {
    if (!Array.isArray(def.input) || def.input.length === 0) fail(`"${def.id}": input must be a non-empty array`)
    for (const mod of def.input) {
      if (!MODALITIES.includes(mod)) {
        fail(`"${def.id}": input modality "${mod}" is not supported by this DSH build (allowed: ${MODALITIES.join(', ')}). Audio/video support depends on the harness, not this plugin.`)
      }
    }
    entry.input = [...def.input]
  }
  if (def.reasoning !== undefined && def.reasoning !== null) {
    if (def.reasoning === true) {
      entry.reasoningEfforts = { ...DEFAULT_EFFORTS }
      if (!entry.compat) entry.compat = {}
      if (!entry.compat.thinkingFormat) entry.compat.thinkingFormat = def.provider === 'openrouter' ? 'openrouter' : undefined
      if (entry.compat.thinkingFormat === undefined) delete entry.compat.thinkingFormat
      if (entry.compat.supportsReasoningEffort === undefined && !entry.compat.thinkingFormat) {
        entry.compat.supportsReasoningEffort = true
      }
    } else if (def.reasoning === false) {
      entry.reasoningEfforts = false
    } else if (typeof def.reasoning === 'object') {
      const map = {}
      for (const [level, wire] of Object.entries(def.reasoning)) {
        if (!LEVELS.includes(level)) fail(`"${def.id}": reasoning level "${level}" invalid (allowed: ${LEVELS.join(', ')})`)
        if (level === 'off') { map.off = wire === null ? null : String(wire); continue }
        if (!isStr(wire)) fail(`"${def.id}": reasoning.${level} needs a wire value (string); only "off" may be null`)
        map[level] = wire
      }
      if (!Object.keys(map).some((l) => l !== 'off')) fail(`"${def.id}": reasoning offers no level beyond "off"; use reasoning:false for a non-reasoning model`)
      entry.reasoningEfforts = map
    } else {
      fail(`"${def.id}": reasoning must be true, false, or an object mapping levels to wire values`)
    }
  }
  if (def.compat !== undefined) {
    if (typeof def.compat !== 'object' || def.compat === null) fail(`"${def.id}": compat must be an object`)
    if (!entry.compat) entry.compat = {}
    for (const [field, value] of Object.entries(def.compat)) {
      if (!COMPAT_OFFERED.includes(field)) {
        fail(`"${def.id}": compat "${field}" is not configurable in this DSH build. Allowed: ${COMPAT_OFFERED.join(', ')}`)
      }
      if (field === 'thinkingFormat' && !THINKING_FORMATS.includes(value)) fail(`"${def.id}": thinkingFormat "${value}" invalid (allowed: ${THINKING_FORMATS.join(', ')})`)
      if (field === 'maxTokensField' && !TOKEN_FIELDS.includes(value)) fail(`"${def.id}": maxTokensField "${value}" invalid (allowed: ${TOKEN_FIELDS.join(', ')})`)
      entry.compat[field] = value
    }
    if (Object.keys(entry.compat).length === 0) delete entry.compat
  }
  const tools = def.tools === undefined ? null : Boolean(def.tools)
  return {
    entry: deepPlain(entry),
    meta: {
      id: def.id,
      name,
      provider: def.provider,
      tools,
      notes: isStr(def.notes) ? def.notes : '',
      aliases: Array.isArray(def.aliases) ? def.aliases.filter(isStr) : [],
    },
  }
}

const PROVIDER_KEYS = ['kind', 'id', 'displayName', 'baseUrl', 'apiKeyEnv', 'api']

/** Friendly provider definition → pi-ai route profile skeleton (validated, never passed through raw). */
function normalizeProvider(def) {
  if (def === null || typeof def !== 'object' || Array.isArray(def)) fail('provider definition must be an object')
  for (const key of Object.keys(def)) {
    if (!PROVIDER_KEYS.includes(key)) fail(`provider "${def.id || '?'}": unknown field "${key}". Allowed: ${PROVIDER_KEYS.join(', ')}`)
  }
  if (!isStr(def.id)) fail('provider definition needs "id" (lowercase letters/digits/hyphens, e.g. "my-gateway")')
  if (!/^[a-z][a-z0-9-]*$/.test(def.id)) fail(`provider id "${def.id}" must start with a lowercase letter and use lowercase letters/digits/hyphens only`)
  const preset = PROVIDER_PRESETS[def.id]
  if (preset) {
    return { id: def.id, displayName: preset.displayName, apiKeyEnv: preset.apiKeyEnv, catalog: true, api: preset.api || undefined, baseUrl: undefined }
  }
  if (!isStr(def.baseUrl) || !/^https?:\/\//.test(def.baseUrl)) fail(`custom provider "${def.id}" needs "baseUrl" starting with http(s):// — e.g. https://api.example.com/v1`)
  if (!isStr(def.api) || !PROTOCOLS.includes(def.api)) fail(`custom provider "${def.id}" needs "api" protocol. Allowed: ${PROTOCOLS.join(', ')}`)
  if (!isStr(def.apiKeyEnv)) fail(`custom provider "${def.id}" needs "apiKeyEnv" — the credential reference name, e.g. MY_GATEWAY_API_KEY (store the actual key via the DSH Models page)`)
  return {
    id: def.id,
    displayName: isStr(def.displayName) ? def.displayName : def.id,
    apiKeyEnv: def.apiKeyEnv,
    catalog: false,
    api: def.api,
    baseUrl: def.baseUrl,
  }
}

/* ═══════════════════════ definition collection ═══════════════════════ */

async function collectDefinitions(ctx) {
  const providers = []
  const models = []
  for (const def of BUILTIN_MODELS) models.push(def)
  if (OVERRIDES_DIR) {
    const fs = ctx.get('fs')
    if (fs !== undefined) {
      try {
        const dirTarget = await fs.resolve(OVERRIDES_DIR)
        const entries = await fs.listDir(dirTarget)
        for (const ent of entries) {
          const fname = ent && ent.name ? String(ent.name) : ''
          if (!fname.endsWith('.json') || /\.example\.json$/i.test(fname)) continue
          try {
            const text = await fs.readText(await fs.resolve(OVERRIDES_DIR + '/' + ent.name))
            const parsed = JSON.parse(text)
            if (parsed && parsed.kind === 'provider') providers.push(parsed)
            else models.push(parsed)
          } catch (error) {
            console.error(`[model-hub] override "${ent.name}" skipped: ${error && error.message}`)
          }
        }
      } catch (error) {
        console.error(`[model-hub] overrides dir unreadable (${OVERRIDES_DIR}): ${error && error.message}`)
      }
    } else if (process.env.MODEL_HUB_OVERRIDES_DIR) {
      console.error('[model-hub] OVERRIDES_DIR set but no fs service mounted; ignoring overrides')
    }
  }
  return { providers, models }
}

/** Expected routes computed purely from definitions (used for ownership checks). */
function buildRoutes(providers, models) {
  const providerDefs = new Map()
  for (const p of providers) {
    const norm = normalizeProvider(p)
    providerDefs.set(norm.id, norm)
  }
  const routes = new Map()
  function routeOf(providerId) {
    const pdef = providerDefs.get(providerId)
    if (pdef) return pdef
    if (PROVIDER_PRESETS[providerId]) return normalizeProvider({ id: providerId })
    fail(`unknown provider "${providerId}". Define it first ({"kind":"provider",…}) or use a built-in preset: ${Object.keys(PROVIDER_PRESETS).join(', ')}`)
  }
  for (const def of models) {
    const { entry, meta } = normalizeModel(def)
    const pdef = routeOf(meta.provider)
    if (!routes.has(pdef.id)) {
      routes.set(pdef.id, {
        profile: {
          apiKeyEnv: pdef.apiKeyEnv,
          displayName: pdef.displayName,
          ...(pdef.catalog ? {} : { api: pdef.api, baseURL: pdef.baseUrl }),
        },
        models: [],
        aliases: [],
      })
    }
    const route = routes.get(pdef.id)
    if (route.models.some((m) => m.id === entry.id)) continue // idempotent by id
    route.models.push(entry)
    for (const alias of meta.aliases) {
      route.aliases.push({ route: `${pdef.id}-${slug(alias)}`, name: alias, id: entry.id })
    }
  }
  return routes
}

function isAliasRouteKey(routeKey, routes) {
  for (const [, route] of routes) {
    if (route.aliases.some((a) => a.route === routeKey)) return true
  }
  return false
}

/**
 * Merge-preserve install for one expected route: append only the plugin's
 * defined models that are currently missing. Never clears existing models,
 * never overwrites user-edited profile fields. Returns models added.
 */
async function ensureRouteModels(ctx, routeKey, route) {
  const providers = (ctx.settings.get('llm-pi-ai') && ctx.settings.get('llm-pi-ai').providers) || {}
  const current = providers[routeKey]
  const existing = Array.isArray(current && current.models) ? current.models : []
  const existingIds = new Set(existing.map((m) => (m && m.id) || ''))
  const missing = route.models.filter((m) => !existingIds.has(m.id))
  if (current !== undefined && missing.length === 0) return { added: [], routeExists: true }
  if (current === undefined) {
    // first install of this route: write the full profile so the Models page
    // shows the route with its credential reference (red dot until a key is added)
    const patch = deepPlain({ providers: { [routeKey]: { ...route.profile, models: [...existing, ...missing] } } })
    await ctx.settings.update('llm-pi-ai', patch)
    return { added: missing.map((m) => m.id), routeExists: false }
  }
  // route exists: merge-preserve — append only the models this plugin defines,
  // never clear user-added models or overwrite user-edited profile fields
  const patch = deepPlain({ providers: { [routeKey]: { models: [...existing, ...missing] } } })
  await ctx.settings.update('llm-pi-ai', patch)
  return { added: missing.map((m) => m.id), routeExists: true }
}

/**
 * Apply every expected route in merge-preserve fashion. Idempotent: repeated
 * installs add nothing. Alias routes are plugin-owned and also merge-preserved
 * (existing alias models kept, missing ones appended).
 */
async function applyRoutes(ctx, routes) {
  const applied = []
  for (const [key, route] of routes) {
    const { added } = await ensureRouteModels(ctx, key, route)
    applied.push(`${key}(+${added.join('+') || 'none'})`)
    for (const alias of route.aliases) {
      // alias routes are plugin-owned; write a full, validated profile so the
      // non-catalog route satisfies pi-ai's api + baseURL requirement
      const aliasKey = alias.route
      const aliasProfile = {
        apiKeyEnv: route.profile.apiKeyEnv,
        displayName: `${route.profile.displayName} · ${alias.name}`,
        api: route.profile.api || (PROVIDER_PRESETS[key] && PROVIDER_PRESETS[key].api) || 'openai-completions',
        baseURL: route.profile.baseURL || (PROVIDER_PRESETS[key] && PROVIDER_PRESETS[key].baseUrl),
      }
      const providersNow = (ctx.settings.get('llm-pi-ai') && ctx.settings.get('llm-pi-ai').providers) || {}
      const curAlias = providersNow[aliasKey]
      const curAliasModels = Array.isArray(curAlias && curAlias.models) ? curAlias.models : []
      if (!curAliasModels.some((m) => m && m.id === alias.id)) {
        await ctx.settings.update('llm-pi-ai', deepPlain({ providers: { [aliasKey]: { ...aliasProfile, models: [...curAliasModels, { id: alias.id, name: alias.name }] } } }))
      }
      applied.push(`${aliasKey}(alias)`)
    }
  }
  return applied
}

/* ═══════════════════════════ plugin ═══════════════════════════ */

export const name = 'model-hub'

export function apply(ctx) {
  const settings = ctx.get('settings')
  if (settings === undefined) {
    console.error('[model-hub] settings service not mounted — cannot write provider config. Refusing to continue.')
    return
  }
  const tools = ctx.get('tools')

  /* ══════════ Model Pool / Gateway subsystem ══════════ */

  // Pool config persists OUTSIDE the package directory (survives upgrades);
  // API keys live ONLY in the DSH credentials service behind secretRefs.
  const poolStore = {
    path: undefined,
    cache: undefined,
    async ensure() {
      if (this.path) return this.path
      const doc = await settings.prepareDocument()
      if (!doc) throw new Error('[model-hub] settings provider is not file-backed; pool persistence unavailable')
      const dir = joinPath(dirname(doc), 'model-hub')
      mkdirSync(dir, { recursive: true })
      this.path = joinPath(dir, 'pool.json')
      return this.path
    },
    load() {
      if (this.cache) return this.cache
      try {
        this.cache = JSON.parse(readFileSync(this.path, 'utf8'))
      } catch {
        this.cache = { channels: [], models: [], pools: [], strategy: 'priority' }
      }
      for (const key of ['channels', 'models', 'pools']) if (!Array.isArray(this.cache[key])) this.cache[key] = []
      if (typeof this.cache.strategy !== 'string') this.cache.strategy = 'priority'
      return this.cache
    },
    save(next) {
      this.cache = next
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(this.path, JSON.stringify(next, null, 2))
    },
  }

  let poolAdapter = null
  // apply() is synchronous; pool init continues asynchronously and registers
  // the routing adapter as soon as the config file location is known.
  poolStore.ensure()
    .then(() => {
      poolStore.load()
      const llm = ctx.get('llm')
      if (llm === undefined || typeof llm.registerAdapter !== 'function') {
        console.error('[model-hub] llm service unavailable — Model Pool routing disabled (config tools still work)')
        return
      }
      poolAdapter = new ModelHubPoolAdapter({
        store: { get: () => poolStore.load() },
        resolveSecret: async (ref) => {
          const credentials = ctx.get('credentials')
          if (credentials === undefined) return undefined
          const resolved = await credentials.resolve(ref)
          return resolved && typeof resolved.value === 'string' ? resolved.value : undefined
        },
        log: (msg) => console.log(msg),
      })
      ctx.effect(llm.registerAdapter([POOL_ROUTE], poolAdapter))
      console.log('[model-hub] model-pool route registered (' + POOL_ROUTE + ')')
    })
    .catch((error) => console.error('[model-hub] pool init failed: ' + (error && error.message ? error.message : String(error))))

  function maskKeyHint(refName) {
    return `${refName} (value stored in DSH credential store; shown only as configured/not configured)`
  }


  /* ---- shared readers ---- */
  async function snapshot() {
    const value = settings.get('llm-pi-ai')
    return (value && value.providers) || {}
  }
  async function keyConfigured(apiKeyEnv) {
    const credentials = ctx.get('credentials')
    if (credentials === undefined || !isStr(apiKeyEnv)) return null
    try {
      const info = await credentials.describe(apiKeyEnv)
      return Boolean(info && (info.configured ?? info.present))
    } catch { return null }
  }
  const mark = (v) => (v === true ? '✓' : v === false ? '✗' : '?')

  /* ---- install on startup: built-ins + overrides (merge-preserve, idempotent) ---- */
  collectDefinitions(ctx)
    .then(({ providers, models }) => applyRoutes(ctx, buildRoutes(providers, models)))
    .then((applied) => {
      if (applied.length > 0) console.log('[model-hub] installed: ' + applied.join('  '))
      console.log('[model-hub] model routes ready. Ask the agent to call model_status anytime.')
    })
    .catch((error) => console.error('[model-hub] install failed: ' + (error && error.message ? error.message : String(error))))

  /* ---- tool registration (ctx.tools.register; skipped if tools missing) ---- */
  function registerTool(definition) {
    if (tools !== undefined) {
      try {
        tools.register(definition)
      } catch (error) {
        console.error('[model-hub] tool registration failed (' + definition.name + '): ' + (error && error.message ? error.message : String(error)))
      }
    }
  }

  registerTool({
    name: 'model_status',
    description:
      '模型健康检查：列出本插件管理的 Provider 路由与模型，检查 API 密钥是否已配置、上下文/视觉/推理能力。可传 route 过滤。 | Health check for managed provider routes & models: API key configured? context/vision/reasoning facts. Optional route filter.',
    parameters: { route: { type: 'string' } },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) { return [{ type: 'text', text: String((value && value.text) || '') }] },
    },
    async execute(args) {
      const providers = await snapshot()
      const wanted = isStr(args.route) ? String(args.route) : null
      const lines = []
      const results = []
      for (const routeKey of Object.keys(providers)) {
        if (wanted && routeKey !== wanted) continue
        const prof = providers[routeKey]
        if (!prof || typeof prof !== 'object') continue
        const keyOk = await keyConfigured(prof.apiKeyEnv)
        lines.push(`${mark(keyOk)} ${routeKey}  key=${prof.apiKeyEnv}${keyOk === false ? ' ← 未配置/missing' : ''}  models:`)
        for (const m of (prof.models || [])) {
          if (!m || typeof m !== 'object') continue
          const vision = Array.isArray(m.input) && m.input.includes('image')
          const reasoning = m.reasoningEfforts && m.reasoningEfforts !== false
          lines.push(`   · ${m.name} <${m.id}> ctx=${m.contextWindow || '?'} vision=${mark(vision)} reasoning=${mark(!!reasoning)} out=${m.maxTokens || '?'}`)
          results.push({ route: routeKey, id: m.id, name: m.name, keyConfigured: keyOk })
        }
      }
      if (lines.length === 0) {
        lines.push(wanted ? `route "${wanted}" 不存在 / not found` : '尚未安装任何路由 / no routes installed — re-run the plugin or model_hub_manage install')
      }
      return { ok: true, text: lines.join('\n'), routes: results }
    },
  })

  registerTool({
    name: 'model_hub_manage',
    description:
      '管理模型路由：install=按内置+覆盖定义幂等安装（只追加本插件定义的缺失模型，不清除用户已有模型）；remove <route>=精确删除本插件管理的路由/模型；reset-route <route>=恢复本插件定义在路由中的在位状态；list=列出全部。 | Manage routes: install (idempotent, merge-preserve), remove <route> (plugin-managed only), reset-route <route> (restore definitions), list.',
    parameters: {
      action: { type: 'string', required: true },
      route: { type: 'string' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) { return [{ type: 'text', text: String((value && value.text) || '') }] },
    },
    async execute(args) {
      const action = String(args.action || '')
      const providers = await snapshot()
      const { providers: provDefs, models } = await collectDefinitions(ctx)
      const expectedRoutes = (() => {
        try { return buildRoutes(provDefs, models) } catch (e) { console.error('[model-hub] ' + e.message); return null }
      })()
      if (action === 'list') {
        const rows = Object.keys(providers).map((k) => `${k}: ${(providers[k].models || []).map((m) => m.id).join(', ') || '(no models)'}`)
        return { ok: true, text: rows.length ? rows.join('\n') : '(empty)' }
      }
      if (action === 'install') {
        if (expectedRoutes === null) return { ok: false, text: 'install failed during definition validation — see host log for the teaching error' }
        const applied = await applyRoutes(ctx, expectedRoutes)
        return { ok: true, text: applied.length ? 'installed (merge-preserve): ' + applied.join('  ') : 'nothing to install' }
      }
      if (action === 'reset-route') {
        const key = String(args.route || '')
        if (expectedRoutes === null) return { ok: false, text: 'reset-route failed during definition validation — see host log' }
        if (isAliasRouteKey(key, expectedRoutes)) {
          // alias route: plugin-owned, rebuild its models to the alias definition
          let aliasEntry = null
          for (const [, r] of expectedRoutes) {
            const a = r.aliases.find((x) => x.route === key)
            if (a) { aliasEntry = { id: a.id, name: a.name }; break }
          }
          await ctx.settings.update('llm-pi-ai', deepPlain({ providers: { [key]: { models: [aliasEntry] } } }))
          return { ok: true, text: `rebuilt alias route ${key} → ${aliasEntry.id}` }
        }
        const route = expectedRoutes.get(key)
        if (!route) return { ok: false, text: `没有本插件定义属于路由 "${key}"；只允许重置本插件管理的路由 / no plugin definitions for "${key}"` }
        const { added } = await ensureRouteModels(ctx, key, route)
        return { ok: true, text: `route "${key}" 已恢复定义在位${added.length ? '（追加 ' + added.join(', ') + '）' : '（无变化）'}; 未删除用户/其他模型 / restored; user models untouched` }
      }
      if (action === 'remove') {
        const key = String(args.route || '')
        if (!providers[key]) return { ok: false, text: `route "${key}" 不存在 / not found` }
        if (expectedRoutes !== null && isAliasRouteKey(key, expectedRoutes)) {
          // plugin-owned alias route → remove entirely; safe, it only ever carried the alias model
          const removed = (providers[key].models || []).map((m) => m.id)
          await ctx.settings.mutate('llm-pi-ai', deepPlain([{ op: 'unset', path: ['providers', key] }]))
          return { ok: true, text: `removed plugin-owned alias route ${key} (was: ${removed.join(', ')}). re-run install to restore.` }
        }
        if (expectedRoutes === null) return { ok: false, text: 'remove needs definitions — validation failed, see host log' }
        const route = expectedRoutes.get(key)
        if (!route) return { ok: false, text: `路由 "${key}" 不是本插件管理的路由，拒绝删除以免影响你的其他配置 / not a plugin-managed route, refusing` }
        // shared route: remove only the models this plugin defines; keep user models
        const current = providers[key]
        const existing = Array.isArray(current && current.models) ? current.models : []
        const definedIds = new Set(route.models.map((m) => m.id))
        const kept = existing.filter((m) => m && !definedIds.has(m.id))
        const removed = existing.filter((m) => m && definedIds.has(m.id)).map((m) => m.id)
        if (kept.length === 0) {
          // only plugin models were on the route → drop the route entirely
          await ctx.settings.mutate('llm-pi-ai', deepPlain([{ op: 'unset', path: ['providers', key] }]))
          return { ok: true, text: `route "${key}" only contained plugin models; removed (was: ${removed.join(', ')}).` }
        }
        // keep route with user models
        await ctx.settings.update('llm-pi-ai', deepPlain({ providers: { [key]: { models: kept } } }))
        return { ok: true, text: `removed plugin models from ${key} (${removed.join(', ')}); kept user models: ${kept.map((m) => m.id).join(', ')}` }
      }
      return { ok: false, text: 'action 必须是 install|remove|reset-route|list / unknown action' }
    },
  })

  registerTool({
    name: 'model_import',
    description:
      '导入并安装一个模型定义（JSON 字符串）。字段：provider,id,name,aliases,contextWindow,maxTokens,input,reasoning,tools,compat。同 id 已存在则跳过（幂等）；aliases 立即物化为兄弟路由。 | Install one model definition (JSON string). Same-id entries are skipped (idempotent); aliases become sibling routes immediately.',
    parameters: { definition: { type: 'string', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) { return [{ type: 'text', text: String((value && value.text) || '') }] },
    },
    async execute(args) {
      let def = args.definition
      if (typeof def === 'string') {
        try { def = JSON.parse(def) } catch (e) {
          return { ok: false, text: 'JSON 解析失败 / invalid JSON: ' + e.message + ' — 检查引号、逗号与花括号 / check quotes, commas and braces' }
        }
      }
      let norm
      try { norm = normalizeModel(def) } catch (error) {
        return { ok: false, text: String(error && error.message) }
      }
      const providerId = norm.meta.provider
      try {
        const providers = await snapshot()
        const profile = providers[providerId]
        if (!profile) {
          return { ok: false, text: `provider "${providerId}" 尚未安装。请先提供 provider 定义（{"kind":"provider",…} 放覆盖目录后重跑 install），或改用内置 preset（openrouter）。/ provider not installed yet` }
        }
        const existing = Array.isArray(profile.models) ? profile.models : []
        if (existing.some((m) => m.id === norm.entry.id)) {
          return { ok: true, text: `"${norm.entry.id}" 已存在，跳过 / already present, skipped`, models: existing.map((m) => m.id) }
        }
        await ctx.settings.update('llm-pi-ai', deepPlain({ providers: { [providerId]: { models: [...existing, norm.entry] } } }))
        const aliasApi = profile.api || (PROVIDER_PRESETS[providerId] && PROVIDER_PRESETS[providerId].api) || 'openai-completions'
        const aliasBase = profile.baseURL || (PROVIDER_PRESETS[providerId] && PROVIDER_PRESETS[providerId].baseUrl)
        const aliasRoutes = []
        for (const alias of norm.meta.aliases) {
          const aliasRoute = `${providerId}-${slug(alias)}`
          const aliasProfile = {
            apiKeyEnv: profile.apiKeyEnv,
            displayName: `${profile.displayName || providerId} · ${alias}`,
            api: aliasApi,
            baseURL: aliasBase,
            models: [{ id: norm.entry.id, name: alias }],
          }
          await ctx.settings.update('llm-pi-ai', deepPlain({ providers: { [aliasRoute]: aliasProfile } }))
          aliasRoutes.push(aliasRoute)
        }
        const aliasHint = aliasRoutes.length > 0 ? ` (alias routes: ${aliasRoutes.join(', ')})` : ''
        return { ok: true, text: `imported ${norm.entry.name} <${norm.entry.id}> → ${providerId}${aliasHint}`, models: [...existing.map((m) => m.id), norm.entry.id] }
      } catch (error) {
        return { ok: false, text: 'import failed: ' + (error && error.message ? error.message : String(error)) }
      }
    },
  })

  registerTool({
    name: 'model_discover',
    description:
      '搜索 OpenRouter 公开模型目录 /models（无需密钥，不发送任何用户数据）：按关键词过滤，返回 id/名称/上下文/是否免费，供 model_import 使用。 | Search OpenRouter public /models catalog (no key needed, no user data sent): filter by keyword, return id/name/context/free flag for model_import.',
    parameters: { keyword: { type: 'string' }, limit: { type: 'number' } },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) { return [{ type: 'text', text: String((value && value.text) || '') }] },
    },
    async execute(args) {
      const keyword = isStr(args.keyword) ? String(args.keyword) : ''
      const limit = Number.isInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, 50) : 15
      let list = []
      const attempts = []
      // Preferred channel: web service if mounted (harness-native HTTP)
      const web = ctx.get('web')
      if (web !== undefined && typeof web.fetch === 'function') {
        try {
          const res = await web.fetch({ url: 'https://openrouter.ai/api/v1/models', method: 'GET' })
          const json = typeof res === 'object' && res !== null ? (res.json !== undefined ? res.json : res) : null
          if (!Array.isArray(json && json.data)) attempts.push('web channel: unexpected catalog shape')
          else list = json.data
        } catch (e) { attempts.push('web channel: ' + ((e && e.message) || String(e))) }
      }
      // Fallback channel: node inline fetch via subprocess (tested path)
      if (list.length === 0) {
        const subprocess = ctx.get('subprocess')
        if (subprocess !== undefined) {
          try {
            const script =
              `fetch('https://openrouter.ai/api/v1/models',{signal:AbortSignal.timeout(8000)}).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json()}).then(function(j){` +
              `var k=process.argv[1]?String(process.argv[1]).toLowerCase():'';` +
              `var d=(j.data||[]).filter(function(m){return !k||String(m.id).toLowerCase().indexOf(k)>=0||String(m.name).toLowerCase().indexOf(k)>=0});` +
              `console.log(JSON.stringify(d));})` +
              `.catch(function(e){console.error(String(e));process.exit(1)});`
            let nodeExe
            try { nodeExe = await subprocess.resolveExecutable('node') } catch { attempts.push('subprocess channel: node not found'); nodeExe = null }
            if (nodeExe !== null) {
              const handle = subprocess.spawn({
                argv: [nodeExe, '-e', script, keyword],
                cwd: '.',
                stdio: { stdin: 'ignore', stdout: { maxBytes: 262144 }, stderr: { maxBytes: 65536 } },
                graceMs: 10000,
              })
              const outcome = await handle.done
              let text = ''
              try { text = handle.collected.stdout ? handle.collected.stdout.readFrom(0).text.trim() : '' } catch {}
              if (outcome.exitCode !== 0) {
                let err = ''
                try { err = handle.collected.stderr ? handle.collected.stderr.readFrom(0).text.trim() : '' } catch {}
                attempts.push('subprocess channel: ' + (err || ('exit ' + outcome.exitCode)))
              } else {
                try { list = JSON.parse(text) } catch { attempts.push('subprocess channel: invalid JSON from catalog') }
              }
            }
          } catch (e) { attempts.push('subprocess channel: ' + ((e && e.message) || String(e))) }
        } else {
          attempts.push('subprocess channel: not mounted')
        }
      }
      if (list.length === 0) return { ok: false, text: 'discovery unavailable: ' + (attempts.join('; ') || 'unknown') }
      const filtered = list
        .filter((m) => !keyword || String(m.id || '').toLowerCase().includes(keyword) || String(m.name || '').toLowerCase().includes(keyword))
        .slice(0, limit)
        .map((m) => ({
          id: m.id,
          name: m.name,
          context: m.context_length,
          free: !!(m.pricing && m.pricing.prompt === '0'),
        }))
      const lines = filtered.map((m) => `${m.free ? '🆓' : '  '} ${m.id}  ·  ${m.name}  ·  ctx ${m.context}`)
      return { ok: true, count: filtered.length, text: lines.length ? lines.join('\n') : 'no matches', candidates: filtered }
    },
  })

  /* ---- Model Pool tools ---- */
  registerTool({
    name: 'model_pool_status',
    description:
      '模型池状态：Provider / Channel / 模型 / 可用性 / 用量计数 / 最近错误（绝不显示密钥明文）。 | Model pool status: providers/channels/models availability, usage counters, last errors. Never shows key values.',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: true }, render(_a, v) { return [{ type: 'text', text: String(v.text || '') }] } },
    async execute() {
      await poolStore.ensure().catch(() => {})
      const cfg = poolStore.load()
      const lines = []
      lines.push(`strategy: ${cfg.strategy}   route: ${POOL_ROUTE}   channels: ${cfg.channels.length}   models: ${cfg.models.length}`)
      for (const ch of cfg.channels) {
        const st = (poolAdapter && poolAdapter.state[ch.id]) || {}
        const keyOk = await keyConfigured(ch.secretRef)
        const quota = ch.expiresAt ? `expiresAt ${ch.expiresAt}` : 'quota unknown'
        lines.push(`${mark(keyOk)} ${ch.id}  [${ch.enabled ? 'enabled' : 'DISABLED'}] ${ch.baseUrl}`)
        lines.push(`   secret=${ch.secretRef} priority=${ch.priority ?? 0} weight=${ch.weight ?? 1} ${quota}`)
        lines.push(`   req=${st.requestCount || 0} err=${st.errorCount || 0} in=${st.inputTokens || 0} out=${st.outputTokens || 0}${st.lastError ? ` lastError=${st.lastError.kind}: ${String(st.lastError.message).slice(0, 120)}` : ''}`)
        if (Array.isArray(ch.models) && ch.models.length > 0) lines.push(`   models: ${ch.models.join(', ')}`)
      }
      for (const m of cfg.models) {
        const chans = cfg.channels.filter((c) => !Array.isArray(c.models) || c.models.length === 0 || c.models.includes(m.id))
        lines.push(`· ${m.displayName} <${m.id}> caps=${(m.capabilities || []).join('+')} channels=${chans.length}`)
        for (const al of m.aliases || []) lines.push(`   alias: ${al}`)
      }
      for (const p of cfg.pools) lines.push(`pool ${p.id}: ${(p.models || []).join(', ')} [${p.strategy}]`)
      if (lines.length <= 1) lines.push('池为空 / pool is empty — use model_pool_add_channel')
      return { ok: true, text: lines.join('\n') }
    },
  })

  registerTool({
    name: 'model_pool_list',
    description:
      '列出模型池中可用的模型与别名（去重后），以及每个模型可用的 Channel 数。 | List deduplicated pool models/aliases with available channel counts.',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: true }, render(_a, v) { return [{ type: 'text', text: String(v.text || '') }] } },
    async execute() {
      await poolStore.ensure().catch(() => {})
      const cfg = poolStore.load()
      const lines = []
      for (const m of cfg.models) {
        const chans = cfg.channels.filter((c) => c.enabled && (!Array.isArray(c.models) || c.models.length === 0 || c.models.includes(m.id)))
        lines.push(`${m.displayName} <${m.id}>  channels=${chans.length}${(m.aliases || []).length ? `  aliases: ${m.aliases.join(', ')}` : ''}`)
      }
      return { ok: true, text: lines.length ? lines.join('\n') : '(empty)' }
    },
  })

  registerTool({
    name: 'model_pool_add_channel',
    description:
      '向模型池添加一个 Channel（同一 Provider 的一个独立 API Key）。参数：id、baseUrl 必填；providerId、secretRef、apiKey（提供则写入 DSH 凭据服务，不会记录到日志）、models（逗号分隔，留空=全部）、priority、weight、expiresAt、timeoutMs。 | Add a channel (one independent API key for a provider). Args: id/baseUrl required; apiKey (if given) goes into the DSH credential store and is never logged; models comma-separated; empty = all models.',
    parameters: {
      id: { type: 'string', required: true },
      baseUrl: { type: 'string', required: true },
      providerId: { type: 'string' },
      secretRef: { type: 'string' },
      apiKey: { type: 'string' },
      models: { type: 'string' },
      priority: { type: 'number' },
      weight: { type: 'number' },
      expiresAt: { type: 'string' },
      timeoutMs: { type: 'number' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render(_a, v) { return [{ type: 'text', text: String(v.text || '') }] } },
    async execute(args) {
      try {
        const raw = {
          id: args.id,
          providerId: args.providerId || 'custom',
          baseUrl: args.baseUrl,
          secretRef: args.secretRef,
          priority: Number.isInteger(args.priority) ? args.priority : undefined,
          weight: Number.isInteger(args.weight) ? args.weight : undefined,
          models: typeof args.models === 'string' && args.models.trim() ? args.models.split(',').map((x) => x.trim()).filter(Boolean) : [],
          expiresAt: args.expiresAt,
          timeoutMs: Number.isInteger(args.timeoutMs) ? args.timeoutMs : undefined,
        }
        const ch = normalizeChannel(raw)
        const cfg = poolStore.load()
        if (cfg.channels.some((c) => c.id === ch.id)) return { ok: false, text: `channel "${ch.id}" 已存在 / already exists` }
        if (args.apiKey && typeof args.apiKey === 'string' && args.apiKey.length > 0) {
          const credentials = ctx.get('credentials')
          if (credentials === undefined) return { ok: false, text: 'credentials 服务未挂载，无法保存密钥 / credential service not mounted' }
          await credentials.set(ch.secretRef, args.apiKey)
        }
        cfg.channels.push(ch)
        poolStore.save(cfg)
        return { ok: true, text: `channel added: ${ch.id} → ${ch.baseUrl}; secret=${maskKeyHint(ch.secretRef)}${args.apiKey ? ' (key stored just now)' : ' (store the key via Settings → Models or credentials)'}` }
      } catch (error) {
        return { ok: false, text: String(error && error.message) }
      }
    },
  })

  registerTool({
    name: 'model_pool_remove_channel',
    description:
      '从模型池移除一个 Channel。只删除本插件创建的 channel 定义；其他 channel 与已存密钥引用不受影响。 | Remove one channel definition created by this plugin; other channels and stored credential refs are untouched.',
    parameters: { id: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: true }, render(_a, v) { return [{ type: 'text', text: String(v.text || '') }] } },
    async execute(args) {
      await poolStore.ensure().catch(() => {})
      const cfg = poolStore.load()
      const idx = cfg.channels.findIndex((c) => c.id === args.id)
      if (idx < 0) return { ok: false, text: `channel "${args.id}" 不存在 / not found` }
      const [gone] = cfg.channels.splice(idx, 1)
      for (const p of cfg.pools) p.models = (p.models || []).filter(() => true)
      poolStore.save(cfg)
      return { ok: true, text: `removed channel "${gone.id}". 其他 channel 不受影响 / other channels untouched. 密钥如需彻底删除请用凭据服务移除引用 ${gone.secretRef}` }
    },
  })

  registerTool({
    name: 'model_pool_test',
    description:
      '对指定 Channel 发起一次真实小请求（"Reply with OK"），报告 HTTP 结果与延迟；不显示密钥。 | Fire one tiny real request at a channel; reports HTTP outcome and latency. Never shows the key.',
    parameters: { id: { type: 'string', required: true }, model: { type: 'string' }, timeoutMs: { type: 'number' } },
    output: { schema: { type: 'object', additionalProperties: true }, render(_a, v) { return [{ type: 'text', text: String(v.text || '') }] } },
    async execute(args) {
      await poolStore.ensure().catch(() => {})
      const cfg = poolStore.load()
      const ch = cfg.channels.find((c) => c.id === args.id)
      if (!ch) return { ok: false, text: `channel "${args.id}" 不存在 / not found` }
      const credentials = ctx.get('credentials')
      let key
      try { const r = await credentials.resolve(ch.secretRef); key = r && r.value } catch {}
      if (!key) return { ok: false, text: `密钥未配置：${ch.secretRef}。请前往 设置 → 模型 或使用 model_pool_add_channel 提供 apiKey。/ key not configured` }
      const modelId = (typeof args.model === 'string' && args.model) || (Array.isArray(ch.models) && ch.models[0]) || 'gpt-4o-mini'
      const started = Date.now()
      try {
        let text = ''
        for await (const chunk of streamAttempt({
          baseUrl: ch.baseUrl,
          apiKey: key,
          modelId,
          payload: { model: modelId, messages: [{ role: 'user', content: 'Reply with exactly: OK' }], stream: true },
          signal: undefined,
          timeoutMs: Number.isInteger(args.timeoutMs) ? args.timeoutMs : (ch.timeoutMs || 15000),
        })) {
          if (chunk.type === 'text-delta') text += chunk.text
        }
        return { ok: true, text: `✓ ${ch.id} responded in ${Date.now() - started}ms with: ${JSON.stringify(text.slice(0, 80))}` }
      } catch (error) {
        return { ok: false, text: `✗ ${ch.id} failed in ${Date.now() - started}ms: ${error.message}` }
      }
    },
  })

  registerTool({
    name: 'model_pool_route',
    description:
      '路由预演（不发请求）：给定模型/别名，按当前策略返回将被选中的 Channel 顺序及原因。 | Dry-run router (no request): for a model/alias returns the ordered channel candidates under the active strategy.',
    parameters: { model: { type: 'string', required: true } },
    output: { schema: { type: 'object', additionalProperties: true }, render(_a, v) { return [{ type: 'text', text: String(v.text || '') }] } },
    async execute(args) {
      await poolStore.ensure().catch(() => {})
      const cfg = poolStore.load()
      const resolved = resolveRequest(cfg, String(args.model || ''))
      if (!resolved) return { ok: false, text: `未知模型或别名 / unknown model or alias: "${args.model}"` }
      const state = poolAdapter ? poolAdapter.state : {}
      const ordered = orderChannels(resolved.channels, resolved.model.id, cfg.strategy || 'priority', state, Date.now())
      const lines = [
        `requested : ${args.model}`,
        `resolved  : ${resolved.model.id} (${resolved.model.displayName})${resolved.viaAlias ? ` via alias ${resolved.viaAlias}` : ''}`,
        `strategy  : ${cfg.strategy || 'priority'}`,
        'candidates:',
        ...ordered.map((c, i) => `  ${i + 1}. ${c.id} (${c.providerId}) priority=${c.priority ?? 0}`),
      ]
      return { ok: true, text: lines.join('\n'), candidates: ordered.map((c) => c.id) }
    },
  })
}