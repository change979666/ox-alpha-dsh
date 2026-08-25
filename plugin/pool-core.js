/**
 * pool-core.js — Model Pool pure logic (no I/O, no DSH imports).
 *
 * Owns: definition normalization, channel ordering strategies, failure
 * classification, cooldowns and usage counters. Everything here is
 * deterministic and unit-testable; I/O lives in pool-adapter.js / index.js.
 */

export const CHANNEL_KEYS = ['id', 'providerId', 'baseUrl', 'secretRef', 'enabled', 'priority', 'weight', 'models', 'expiresAt', 'metadata', 'timeoutMs']
export const MODEL_DEF_KEYS = ['id', 'displayName', 'capabilities', 'contextWindow', 'maxOutputTokens', 'aliases']
export const POOL_KEYS = ['id', 'name', 'models', 'strategy', 'fallback', 'enabled']

export const STRATEGIES = ['priority', 'round-robin', 'weighted', 'least-used', 'quota-aware', 'expiration-first']
export const CAPABILITIES = ['text', 'vision', 'audio', 'video', 'reasoning', 'toolCalling', 'structuredOutput']

/** Upstream failure taxonomy — decides cooldown vs immediate next vs abort. */
export function classifyFailure(statusOrError) {
  if (typeof statusOrError === 'number') {
    if (statusOrError === 401 || statusOrError === 403) return { kind: 'auth', retryOnSameModel: true, cooldownMs: 60000 }
    if (statusOrError === 402 || statusOrError === 429) return { kind: 'rate-or-quota', retryOnSameModel: true, cooldownMs: 60000 }
    if (statusOrError >= 500) return { kind: 'server', retryOnSameModel: true, cooldownMs: 15000 }
    if (statusOrError === 404) return { kind: 'model-missing', retryOnSameModel: false, cooldownMs: 30000 }
    return { kind: 'bad-request', retryOnSameModel: false, cooldownMs: 0 }
  }
  const text = String(statusOrError || '')
  if (/abort/i.test(text)) return { kind: 'timeout', retryOnSameModel: true, cooldownMs: 10000 }
  if (/fetch failed|network|econn|enotfound|etimedout/i.test(text)) return { kind: 'network', retryOnSameModel: true, cooldownMs: 15000 }
  return { kind: 'unknown', retryOnSameModel: true, cooldownMs: 5000 }
}

export function isTransientFailure(kind) {
  // Model fallback triggers ONLY on availability-class failures (§六),
  // never on ordinary generation errors.
  return ['rate-or-quota', 'server', 'timeout', 'network', 'model-missing', 'auth'].includes(kind)
}

/**
 * Order candidate channels for one requested model under a strategy.
 * Filters first: enabled → supports model → not in cooldown.
 * @param channels raw channel records (already normalized)
 * @param modelId requested model id
 * @param strategy one of STRATEGIES
 * @param state per-channel runtime stats { [channelId]: { errors, lastErrorAt, cooldownUntil, uses } }
 * @param now epoch ms
 */
export function orderChannels(channels, modelId, strategy, state, now) {
  // weighted needs ONE random draw per candidate taken before sorting,
  // otherwise an unstable comparator can produce inconsistent orders.
  const jitter = new Map(channels.map((c) => [c.id, -Math.random() * Math.max(1, c.weight || 1)]))
  const candidates = channels.filter((c) => {
    if (!c.enabled) return false
    if (Array.isArray(c.models) && c.models.length > 0 && !c.models.includes(modelId)) return false
    const st = state[c.id]
    if (st && st.cooldownUntil && st.cooldownUntil > now) return false
    return true
  })
  const score = (c) => {
    const st = state[c.id] || {}
    switch (strategy) {
      case 'priority': return [(c.priority || 0) * -1, c.id]
      case 'least-used': return [(st.uses || 0), c.id]
      case 'quota-aware':
      case 'expiration-first': {
        // expiration-first: sooner expiresAt first; missing expiresAt sorts last
        const t = c.expiresAt ? Date.parse(c.expiresAt) : Number.MAX_SAFE_INTEGER
        return [t, -(c.priority || 0), c.id]
      }
      case 'weighted': return [jitter.get(c.id), c.id]
      case 'round-robin':
      default: {
        const rr = st.roundRobinSeq != null ? st.roundRobinSeq : 0
        return [rr, -(c.priority || 0), c.id]
      }
    }
  }
  return candidates.sort((a, b) => {
    const sa = score(a); const sb = score(b)
    if (sa[0] < sb[0]) return -1
    if (sa[0] > sb[0]) return 1
    if (sa[1] < sb[1]) return -1
    if (sa[1] > sb[1]) return 1
    return 0
  })
}

/** Advance round-robin sequence bookkeeping after a channel attempt succeeds/fails terminally. */
export function bumpRoundRobin(state, channelId) {
  const st = (state[channelId] = state[channelId] || {})
  st.roundRobinSeq = (globalThis.__mh_rr_seq = (globalThis.__mh_rr_seq || 0) + 1)
}

export function recordSuccess(state, channelId, modelId, usage) {
  const st = (state[channelId] = state[channelId] || {})
  st.uses = (st.uses || 0) + 1
  st.requestCount = (st.requestCount || 0) + 1
  st.lastUsedAt = new Date().toISOString()
  st.lastModel = modelId
  delete st.lastError
  st.cooldownUntil = 0
  if (usage) {
    st.inputTokens = (st.inputTokens || 0) + (Number(usage.input) || 0)
    st.outputTokens = (st.outputTokens || 0) + (Number(usage.output) || 0)
  }
}

export function recordFailure(state, channelId, modelId, classification, message) {
  const st = (state[channelId] = state[channelId] || {})
  st.errorCount = (st.errorCount || 0) + 1
  st.lastError = { at: new Date().toISOString(), model: modelId, kind: classification.kind, message: String(message || '').slice(0, 300) }
  if (classification.cooldownMs > 0) st.cooldownUntil = Date.now() + classification.cooldownMs
}

/** Normalize + validate one channel definition. Teaching errors; strict whitelist. */
export function normalizeChannel(def) {
  if (def === null || typeof def !== 'object' || Array.isArray(def)) throw new Error('channel definition must be an object')
  for (const key of Object.keys(def)) {
    if (!CHANNEL_KEYS.includes(key)) throw new Error(`channel: unknown field "${key}". Allowed: ${CHANNEL_KEYS.join(', ')}`)
  }
  if (typeof def.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(def.id)) throw new Error('channel needs "id": lowercase letters/digits/hyphens starting with a letter')
  if (typeof def.providerId !== 'string' || !def.providerId) throw new Error(`channel "${def.id}" needs "providerId"`)
  if (typeof def.baseUrl !== 'string' || !/^https?:\/\//.test(def.baseUrl)) throw new Error(`channel "${def.id}" needs "baseUrl" starting with http(s)://`)
  if (def.secretRef !== undefined && (typeof def.secretRef !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(def.secretRef))) {
    throw new Error(`channel "${def.id}" secretRef must be an UPPER_CASE credential reference name`)
  }
  return {
    id: def.id,
    providerId: def.providerId,
    baseUrl: def.baseUrl.replace(/\/+$/, ''),
    secretRef: typeof def.secretRef === 'string' ? def.secretRef : `MODELHUB_CHANNEL_${def.id.replace(/[^a-z0-9]/gi, '_').toUpperCase()}`,
    enabled: def.enabled === undefined ? true : Boolean(def.enabled),
    priority: Number.isInteger(def.priority) ? def.priority : 0,
    weight: Number.isInteger(def.weight) && def.weight > 0 ? def.weight : 1,
    timeoutMs: Number.isInteger(def.timeoutMs) && def.timeoutMs > 0 ? def.timeoutMs : undefined,
    models: Array.isArray(def.models) ? [...def.models] : [],
    expiresAt: typeof def.expiresAt === 'string' && !Number.isNaN(Date.parse(def.expiresAt)) ? def.expiresAt : undefined,
    metadata: def.metadata && typeof def.metadata === 'object' ? { ...def.metadata } : undefined,
  }
}

/** Normalize one model definition for the pool. capabilities whitelist enforced. */
export function normalizePoolModel(def) {
  if (def === null || typeof def !== 'object' || Array.isArray(def)) throw new Error('model definition must be an object')
  for (const key of Object.keys(def)) {
    if (!MODEL_DEF_KEYS.includes(key)) throw new Error(`pool model: unknown field "${key}". Allowed: ${MODEL_DEF_KEYS.join(', ')}`)
  }
  if (typeof def.id !== 'string' || !def.id) throw new Error('pool model needs "id" (the exact upstream model id)')
  const capsSource = def.capabilities && typeof def.capabilities === 'object' ? Object.keys(def.capabilities).filter((k) => def.capabilities[k]) : []
  for (const cap of capsSource) {
    if (!CAPABILITIES.includes(cap)) throw new Error(`pool model "${def.id}": capability "${cap}" unknown. Allowed: ${CAPABILITIES.join(', ')}`)
  }
  const aliases = Array.isArray(def.aliases) ? def.aliases.filter((a) => typeof a === 'string' && a) : []
  return {
    id: def.id,
    displayName: typeof def.displayName === 'string' && def.displayName ? def.displayName : def.id,
    capabilities: capsSource.length ? capsSource : ['text'],
    contextWindow: Number.isInteger(def.contextWindow) ? def.contextWindow : undefined,
    maxOutputTokens: Number.isInteger(def.maxOutputTokens) ? def.maxOutputTokens : undefined,
    aliases,
  }
}

/** Resolve a requested pool model id/alias → concrete model + candidate channels. */
export function resolveRequest(poolConfig, requestedId) {
  const models = poolConfig.models || []
  let model = models.find((m) => m.id === requestedId)
  let viaAlias = null
  if (!model) {
    for (const m of models) {
      if ((m.aliases || []).includes(requestedId)) { model = m; viaAlias = requestedId; break }
    }
  }
  if (!model) return null
  const channels = (poolConfig.channels || []).filter(
    (c) => c.enabled && (!Array.isArray(c.models) || c.models.length === 0 || c.models.includes(model.id)),
  )
  return { model, viaAlias, channels }
}
