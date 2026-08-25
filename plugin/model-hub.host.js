/**
 * Model Hub for DSH 🔌 — lightweight model/provider integration toolkit
 * =============================================================================
 * One plugin, multiple providers, many models. Ox Alpha is just the first
 * built-in definition — adding a model means adding a definition, not code.
 *
 * Pipeline:
 *   model/provider definitions (friendly JSON schema)
 *     → normalize (teaching errors, whitelist, id/name separation)
 *     → pi-ai provider profiles
 *     → deepPlain(null-prototype) cross-realm wrapper
 *     → ctx.settings.update('llm-pi-ai', patch)   [official seam: live+durable]
 *
 * Tools registered:
 *   model_status      health report: route / api key / per-model facts
 *   model_hub_manage  install | remove <route> | reset-route <route> | list
 *   model_import      install one definition from a JSON string/object
 *   model_discover    search OpenRouter's public /models catalog
 *
 * Security: this plugin NEVER reads key values. It only writes the *reference*
 * name (apiKeyEnv) into settings and asks the credentials service whether a
 * reference is configured (boolean). Keys are pasted by you in the GUI.
 *
 * This file is the complete `code.host`. No client half, no dependencies.
 */

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
    notes: 'anonymous stealth provider; free promo; prompts retained by provider',
  },
]

/* ═══════════════════════════ helpers ═══════════════════════════ */

function fail(msg) { throw new Error('[model-hub] ' + msg) }

function isStr(v) { return typeof v === 'string' && v.length > 0 }

function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'alias'
}

/**
 * Rebuild plain objects with NULL prototypes. Dynamic-plugin code runs in an
 * isolated realm; its Object.prototype differs from the host realm's, and the
 * settings service rejects such values ("must be a plain object"). Objects
 * with proto===null pass everywhere. Required, not cosmetic.
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
  if (!isStr(def.provider)) fail('model definition needs "provider" (e.g. "openrouter" or a custom provider id)')
  if (!isStr(def.id)) fail('model definition needs "id" — the exact model id sent to the API')
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

  // reasoning: true | false | { level: wireValue }
  if (def.reasoning !== undefined && def.reasoning !== null) {
    if (def.reasoning === true) {
      entry.reasoningEfforts = { ...DEFAULT_EFFORTS }
      if (!entry.compat) entry.compat = {}
      if (!entry.compat.thinkingFormat) {
        entry.compat.thinkingFormat = def.provider === 'openrouter' ? 'openrouter' : undefined
      }
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

  // compat passthrough (whitelist; withheld/unknown fields get teaching errors)
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
    meta: { id: def.id, name, provider: def.provider, tools, notes: isStr(def.notes) ? def.notes : '', aliases: Array.isArray(def.aliases) ? def.aliases.filter(isStr) : [] },
  }
}

const PROVIDER_KEYS = ['kind', 'id', 'displayName', 'baseUrl', 'apiKeyEnv', 'api']

/** Friendly provider definition → pi-ai route profile skeleton. */
function normalizeProvider(def) {
  if (def === null || typeof def !== 'object' || Array.isArray(def)) fail('provider definition must be an object')
  for (const key of Object.keys(def)) {
    if (!PROVIDER_KEYS.includes(key)) fail(`provider "${def.id || '?'}": unknown field "${key}". Allowed: ${PROVIDER_KEYS.join(', ')}`)
  }
  if (!isStr(def.id)) fail('provider definition needs "id" (lowercase letters/digits/hyphens, e.g. "my-gateway")')
  if (!/^[a-z][a-z0-9-]*$/.test(def.id)) fail(`provider id "${def.id}" must start with a lowercase letter and use lowercase letters/digits/hyphens only`)
  const preset = PROVIDER_PRESETS[def.id]
  if (preset) {
    return { id: def.id, displayName: preset.displayName, apiKeyEnv: preset.apiKeyEnv, catalog: true, api: undefined, baseUrl: undefined }
  }
  if (!isStr(def.baseUrl) || !/^https?:\/\//.test(def.baseUrl)) fail(`custom provider "${def.id}" needs "baseUrl" starting with http(s):// — e.g. https://api.example.com/v1`)
  if (!isStr(def.api) || !PROTOCOLS.includes(def.api)) fail(`custom provider "${def.id}" needs "api" protocol. Allowed: ${PROTOCOLS.join(', ')}`)
  if (!isStr(def.apiKeyEnv)) fail(`custom provider "${def.id}" needs "apiKeyEnv" — the credential reference name, e.g. MY_GATEWAY_API_KEY (store the actual key via Settings → Models)`)
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
    } else {
      console.error('[model-hub] OVERRIDES_DIR set but no fs service mounted; ignoring overrides')
    }
  }
  return { providers, models }
}

/** Group normalized models under their provider routes; expand aliases. */
function buildRoutes(providers, models) {
  const providerDefs = new Map()
  for (const p of providers) {
    const norm = normalizeProvider(p)
    providerDefs.set(norm.id, norm)
  }
  /** route → { profile, models: [entry], metas: [], aliases: [{route,name,id}] } */
  const routes = new Map()
  function routeOf(providerId) {
    const pdef = providerDefs.get(providerId)
    if (pdef) return pdef
    if (PROVIDER_PRESETS[providerId]) return normalizeProvider({ id: providerId })
    fail(`unknown provider "${providerId}". Add a provider definition first ({"kind":"provider",…}) or use a built-in preset: ${Object.keys(PROVIDER_PRESETS).join(', ')}`)
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
        metas: [],
        aliases: [],
      })
    }
    const route = routes.get(pdef.id)
    if (route.models.some((m) => m.id === entry.id)) continue // idempotent by id
    route.models.push(entry)
    route.metas.push(meta)
    for (const alias of meta.aliases) {
      route.aliases.push({ route: `${pdef.id}-${slug(alias)}`, name: alias, id: entry.id })
    }
  }
  return routes
}

function routePatch(route) {
  return deepPlain({
    providers: {
      [routeKeyOf(route)]: { ...route.profile, models: route.models },
    },
  })
}
function routeKeyOf(route) { return route.__key }
function withKey(key, route) { route.__key = key; return route }

async function applyRoutes(ctx, routes) {
  const settings = ctx.settings
  const applied = []
  for (const [key, route] of routes) {
    route.__key = key
    await settings.update('llm-pi-ai', routePatch(withKey(key, route)))
    applied.push(`${key}(${route.models.map((m) => m.id).join(', ')})`)
    for (const alias of route.aliases) {
      const aliasProfile = {
        apiKeyEnv: route.profile.apiKeyEnv,
        displayName: `${route.profile.displayName} · ${alias.name}`,
        api: route.profile.api || (PROVIDER_PRESETS[route.__key] && PROVIDER_PRESETS[route.__key].api) || 'openai-completions',
        baseURL: route.profile.baseURL || (PROVIDER_PRESETS[route.__key] && PROVIDER_PRESETS[route.__key].baseUrl),
        models: [{ id: alias.id, name: alias.name }],
      }
      await settings.update('llm-pi-ai', deepPlain({ providers: { [alias.route]: aliasProfile } }))
      applied.push(`${alias.route}(→${alias.id})`)
    }
  }
  return applied
}

/* ═══════════════════════════ plugin ═══════════════════════════ */

return {
  inject: ['settings'],
  apply(ctx) {
    /* ---- startup install (idempotent): built-ins + overrides ---- */
    collectDefinitions(ctx)
      .then(({ providers, models }) => applyRoutes(ctx, buildRoutes(providers, models)))
      .then((applied) => {
        if (applied.length > 0) console.log('[model-hub] installed: ' + applied.join('  '))
        console.log('[model-hub] next step: Settings → Models → paste the API key(s); ask the agent to call model_status anytime.')
      })
      .catch((error) => console.error('[model-hub] install failed: ' + (error && error.message ? error.message : String(error))))

    /* ---- shared readers ---- */
    async function snapshot() {
      const value = ctx.settings.get('llm-pi-ai')
      const providers = (value && value.providers) || {}
      return providers
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

    /* ---- tool: model_status ---- */
    harness.registerTool(ctx, harness.defineTool({
      name: 'model_status',
      description:
        '模型健康检查：列出本插件管理的 Provider 路由与模型，检查 API 密钥是否已配置、上下文/视觉/推理/工具能力。可传 route 过滤。 | Health check for managed provider routes & models: API key configured? context/vision/reasoning/tools facts. Optional route filter.',
      parameters: { route: { type: 'string' } },
      output: { schema: { type: 'object', additionalProperties: true }, render(_a, v) { return [{ type: 'text', text: String(v.text || '') }] } },
      async execute(args) {
        const providers = await snapshot()
        const wanted = isStr(args.route) ? args.route : null
        const lines = []
        const results = []
        for (const routeKey of Object.keys(providers)) {
          if (wanted && routeKey !== wanted) continue
          const prof = providers[routeKey]
          if (!prof || typeof prof !== 'object') continue
          const keyOk = await keyConfigured(prof.apiKeyEnv)
          lines.push(`${mark(keyOk)} ${routeKey}  key=${prof.apiKeyEnv}${keyOk === false ? ' ← 未配置/missing' : ''}  models:`)
          for (const m of prof.models || []) {
            if (!m || typeof m !== 'object') continue
            const vision = Array.isArray(m.input) && m.input.includes('image')
            const reasoning = m.reasoningEfforts && m.reasoningEfforts !== false
            lines.push(`   · ${m.name} <${m.id}> ctx=${m.contextWindow || '?'} vision=${mark(vision)} reasoning=${mark(!!reasoning)} out=${m.maxTokens || '?'}`)
            results.push({ route: routeKey, id: m.id, name: m.name, keyConfigured: keyOk })
          }
        }
        if (lines.length === 0) lines.push(wanted ? `route "${wanted}" 不存在 / not found` : '尚未安装任何路由 / no routes installed — re-run the plugin or model_hub_manage install')
        return { ok: true, text: lines.join('\n'), routes: results }
      },
    }))

    /* ---- tool: model_hub_manage ---- */
    harness.registerTool(ctx, harness.defineTool({
      name: 'model_hub_manage',
      description:
        '管理模型路由：install=按内置+覆盖定义重新安装（幂等）；remove=删除一个路由（回滚）；reset-route=按定义重建某路由（清掉手工导入的模型）；list=列出全部。 | Manage routes: install (idempotent), remove <route> (rollback), reset-route <route> (rebuild from definitions), list.',
      parameters: {
        action: { type: 'string', required: true },
        route: { type: 'string' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render(_a, v) { return [{ type: 'text', text: String(v.text || '') }] } },
      async execute(args) {
        const action = String(args.action || '')
        const providers = await snapshot()
        if (action === 'list') {
          const rows = Object.keys(providers).map((k) => `${k}: ${(providers[k].models || []).map((m) => m.id).join(', ') || '(no models)'}`)
          return { ok: true, text: rows.length ? rows.join('\n') : '(empty)' }
        }
        if (action === 'remove') {
          const key = String(args.route || '')
          if (!providers[key]) return { ok: false, text: `route "${key}" 不存在 / not found` }
          const removed = (providers[key].models || []).map((m) => m.id)
          await ctx.settings.mutate('llm-pi-ai', deepPlain([{ op: 'unset', path: ['providers', key] }]))
          return { ok: true, text: `removed ${key} (was: ${removed.join(', ')}). 重新运行 install 可恢复 / re-run install to restore.` }
        }
        if (action === 'reset-route') {
          const key = String(args.route || '')
          const { providers: provDefs, models } = await collectDefinitions(ctx)
          const routes = buildRoutes(provDefs, models.filter((m) => (m.provider || 'openrouter') === key))
          const route = routes.get(key)
          if (!route) return { ok: false, text: `没有定义属于路由 "${key}" 或路由未知 / no definitions belong to "${key}"` }
          await ctx.settings.update('llm-pi-ai', routePatch(withKey(key, route)))
          return { ok: true, text: `rebuilt ${key}: ${route.models.map((m) => m.id).join(', ')}` }
        }
        if (action === 'install') {
          const { providers: provDefs, models } = await collectDefinitions(ctx)
          const routes = buildRoutes(provDefs, models)
          const applied = await applyRoutes(ctx, routes)
          return { ok: true, text: applied.length ? 'installed: ' + applied.join('  ') : 'nothing to install' }
        }
        return { ok: false, text: 'action 必须是 install|remove|reset-route|list / unknown action' }
      },
    }))

    /* ---- tool: model_import ---- */
    harness.registerTool(ctx, harness.defineTool({
      name: 'model_import',
      description:
        '导入并安装一个模型定义（JSON 对象或 JSON 字符串）。字段：provider,id,name,aliases,contextWindow,maxTokens,input,reasoning,tools,compat。同 id 已存在则跳过（幂等）。 | Install one model definition (JSON object/string). Same-id entries are skipped (idempotent).',
      parameters: { definition: { type: 'string', required: true } },
      output: { schema: { type: 'object', additionalProperties: true }, render(_a, v) { return [{ type: 'text', text: String(v.text || '') }] } },
      async execute(args) {
        let def = args.definition
        if (typeof def === 'string') { try { def = JSON.parse(def) } catch (e) { return { ok: false, text: 'JSON 解析失败 / invalid JSON: ' + e.message } } }
        let norm
        try { norm = normalizeModel(def) } catch (error) { return { ok: false, text: String(error && error.message) } }
        const providerId = norm.meta.provider
        const providers = await snapshot()
        const profile = providers[providerId]
        if (!profile) return { ok: false, text: `provider "${providerId}" 尚未安装。先用 model_hub_manage install 安装内置/覆盖定义，或添加 provider 定义。/ provider not installed yet` }
        const existing = Array.isArray(profile.models) ? profile.models : []
        if (existing.some((m) => m.id === norm.entry.id)) {
          return { ok: true, text: `"${norm.entry.id}" 已存在，跳过 / already present, skipped`, models: existing.map((m) => m.id) }
        }
        const merged = deepPlain({
          providers: { [providerId]: { models: [...existing, norm.entry] } },
        })
        await ctx.settings.update('llm-pi-ai', merged)
        // materialize aliases immediately as sibling routes sharing the same key
        const aliasRoutes = []
        for (const alias of norm.meta.aliases) {
          const aliasRoute = `${providerId}-${slug(alias)}`
          const aliasProfile = {
            apiKeyEnv: profile.apiKeyEnv,
            displayName: `${profile.displayName || providerId} · ${alias}`,
            api: profile.api || (PROVIDER_PRESETS[providerId] && PROVIDER_PRESETS[providerId].api) || 'openai-completions',
            baseURL: profile.baseURL || (PROVIDER_PRESETS[providerId] && PROVIDER_PRESETS[providerId].baseUrl),
            models: [{ id: norm.entry.id, name: alias }],
          }
          await ctx.settings.update('llm-pi-ai', deepPlain({ providers: { [aliasRoute]: aliasProfile } }))
          aliasRoutes.push(aliasRoute)
        }
        const aliasHint = aliasRoutes.length > 0 ? ` (alias routes: ${aliasRoutes.join(', ')})` : ''
        return { ok: true, text: `imported ${norm.entry.name} <${norm.entry.id}> → ${providerId}${aliasHint}`, models: [...existing.map((m) => m.id), norm.entry.id] }
      },
    }))

    /* ---- tool: model_discover ---- */
    harness.registerTool(ctx, harness.defineTool({
      name: 'model_discover',
      description:
        '搜索 OpenRouter 公开模型目录（无需密钥）：按关键词过滤，返回 id/名称/上下文/输入价，供 model_import 使用。 | Search OpenRouter public catalog (no key needed): filter by keyword, return candidates for model_import.',
      parameters: { keyword: { type: 'string' }, limit: { type: 'number' } },
      output: { schema: { type: 'object', additionalProperties: true }, render(_a, v) { return [{ type: 'text', text: String(v.text || '') }] } },
      async execute(args) {
        const subprocess = ctx.get('subprocess')
        if (subprocess === undefined) return { ok: false, text: 'subprocess 服务未挂载 / subprocess service not mounted' }
        const keyword = isStr(args.keyword) ? args.keyword : ''
        const limit = Number.isInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, 50) : 15
        const script =
          "fetch('https://openrouter.ai/api/v1/models').then(function(r){return r.json()}).then(function(j){" +
          "var k=process.argv[1]?String(process.argv[1]).toLowerCase():'';" +
          "var d=(j.data||[]).filter(function(m){return !k||String(m.id).toLowerCase().indexOf(k)>=0||String(m.name).toLowerCase().indexOf(k)>=0})" +
          ".slice(0," + limit + ").map(function(m){return {id:m.id,name:m.name,context:m.context_length,free:m.pricing&&m.pricing.prompt==='0'}});" +
          "console.log(JSON.stringify(d));})" +
          ".catch(function(e){console.error(String(e));process.exit(1)});"
        let nodeExe
        try { nodeExe = await subprocess.resolveExecutable('node') } catch { return { ok: false, text: 'node 不可用 / node not found' } }
        const handle = subprocess.spawn({
          argv: [nodeExe, '-e', script, keyword],
          cwd: '.',
          stdio: { stdin: 'ignore', stdout: { maxBytes: 262144 }, stderr: { maxBytes: 65536 } },
          graceMs: 8000,
        })
        const outcome = await handle.done
        let text = ''
        try { text = handle.collected.stdout ? handle.collected.stdout.readFrom(0).text.trim() : '' } catch {}
        if (outcome.exitCode !== 0) {
          let err = ''
          try { err = handle.collected.stderr ? handle.collected.stderr.readFrom(0).text.trim() : '' } catch {}
          return { ok: false, text: 'discovery failed: ' + (err || ('exit ' + outcome.exitCode)) }
        }
        let list = []
        try { list = JSON.parse(text) } catch { return { ok: false, text: 'unexpected catalog response' } }
        const lines = list.map((m) => `${m.free ? '🆓' : '  '} ${m.id}  ·  ${m.name}  ·  ctx ${m.context}`)
        return { ok: true, count: list.length, text: lines.length ? lines.join('\n') : 'no matches', candidates: list }
      },
    }))
  },
}
