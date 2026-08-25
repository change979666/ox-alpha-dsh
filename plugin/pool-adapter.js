/**
 * pool-adapter.js — Model Pool LLM adapter + OpenAI-compatible transport.
 *
 * Implements the DSH LlmAdapter SURFACE (duck-typed: providerInfo /
 * providerRetryPolicy / listModels / resolveModel / prepareCall / stream) for
 * the synthetic provider route `model-pool`. The registry does not require a
 * base class; when @deepseek-ai/dsh-llm is resolvable we still import
 * attributionHeaders() to honor the harness attribution contract on every
 * upstream request.
 *
 * Failover (P0):
 *   per requested model → candidate channels ordered by strategy →
 *   attempt each with per-attempt timeout → classify failure →
 *   cooldown channel → next candidate. Bounded attempts, exponential backoff.
 *
 * Secrets: upstream Authorization comes from ctx.credentials.resolve(secretRef)
 * at dispatch time. Keys never appear in config files, logs or tool output.
 */

import {
  normalizeChannel,
  normalizePoolModel,
  resolveRequest,
  orderChannels,
  classifyFailure,
  recordSuccess,
  recordFailure,
  STRATEGIES,
} from './pool-core.js'

export const POOL_ROUTE = 'model-pool'
const MAX_ATTEMPTS = 5
const BASE_BACKOFF_MS = 250
const MAX_BACKOFF_MS = 2000

/** Try to honor the harness attribution contract without hard-failing. */
let cachedAttribution = { tried: false, headers: null }
async function getAttribution() {
  if (!cachedAttribution.tried) {
    cachedAttribution.tried = true
    try {
      const mod = await import('@deepseek-ai/dsh-llm')
      if (typeof mod.attributionHeaders === 'function') cachedAttribution.headers = mod.attributionHeaders()
    } catch {
      cachedAttribution.headers = null // optional enhancement only
    }
  }
  return cachedAttribution.headers
}

/** Build an OpenAI Chat Completions payload from Harness GenerateOptions. */
export function buildChatPayload(options, upstreamModelId) {
  const messages = []
  const sys = options.systemPrompt ?? options.system
  if (typeof sys === 'string' && sys.length > 0) messages.push({ role: 'system', content: sys })
  for (const message of Array.isArray(options.messages) ? options.messages : []) {
    const role = message.role
    const blocks = Array.isArray(message.content) ? message.content : (typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : [])
    if (role === 'tool' || blocks.some((b) => b && b.type === 'tool-result')) {
      const textParts = []
      let toolCallId = message.toolCallId || message.callId
      for (const b of blocks) {
        if (!b || typeof b !== 'object') continue
        if (b.type === 'text' && typeof b.text === 'string') textParts.push(b.text)
        if (b.type === 'tool-result') {
          toolCallId = b.toolCallId || b.callId || b.id || toolCallId
          const inner = Array.isArray(b.content) ? b.content : []
          for (const c of inner) if (c && c.type === 'text' && typeof c.text === 'string') textParts.push(c.text)
        }
      }
      messages.push({ role: 'tool', tool_call_id: toolCallId || undefined, content: textParts.join('\n') })
      continue
    }
    const text = blocks.filter((b) => b && b.type === 'text').map((b) => b.text).join('')
    const toolCalls = blocks
      .filter((b) => b && b.type === 'tool-call')
      .map((b) => ({
        id: b.id || `call_${Math.random().toString(36).slice(2)}`,
        type: 'function',
        function: { name: b.name, arguments: typeof b.arguments === 'string' ? b.arguments : JSON.stringify(b.arguments || {}) },
      }))
    if (role === 'assistant') {
      messages.push(toolCalls.length > 0
        ? { role: 'assistant', ...(text ? { content: text } : {}), tool_calls: toolCalls }
        : { role: 'assistant', content: text })
      continue
    }
    messages.push({ role: role === 'system' ? 'system' : 'user', content: text })
  }
  const payload = {
    model: upstreamModelId,
    messages,
    stream: true,
  }
  if (options.temperature !== undefined) payload.temperature = options.temperature
  if (options.maxTokens !== undefined) payload.max_tokens = options.maxTokens
  if (Array.isArray(options.tools)) {
    const normalized = options.tools.map((t) => (
      t && t.type === 'function' && t.function ? t
        : { type: 'function', function: { name: t.name, description: t.description || '', parameters: t.parameters || { type: 'object', properties: {} } } }
    ))
    if (normalized.length > 0) payload.tools = normalized
  }
  return payload
}

/** Minimal SSE line reader over a fetch Response body. */
async function* sseLines(response) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let nl
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, '')
      buffer = buffer.slice(nl + 1)
      if (line.startsWith('data:')) yield line.slice(5).trim()
    }
  }
}

/**
 * Stream one attempt against one channel. Yields DSH StreamChunks.
 * Throws on terminal-per-channel failures; caller decides failover.
 */
export async function* streamAttempt({ baseUrl, apiKey, modelId, payload, signal, timeoutMs }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('attempt timeout')), timeoutMs)
  const onAbort = () => controller.abort(new Error('caller aborted'))
  if (signal) {
    if (signal.aborted) { clearTimeout(timer); throw new Error('caller aborted') }
    signal.addEventListener('abort', onAbort, { once: true })
  }
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      throw Object.assign(new Error(`HTTP ${res.status}: ${errText.slice(0, 200)}`), { httpStatus: res.status })
    }
    let index = -1
    let openedText = false
    let finishReason = null
    let sawUsageEvent = false
    const finishToolCalls = new Map()
    for await (const data of sseLines(res)) {
      if (data === '[DONE]') break
      let evt
      try { evt = JSON.parse(data) } catch { continue }
      const delta = evt.choices && evt.choices[0] && (evt.choices[0].delta || {})
      if (evt.choices && evt.choices[0] && evt.choices[0].finish_reason) finishReason = evt.choices[0].finish_reason
      if (evt.usage) sawUsageEvent = true
      if (delta.content) {
        if (!openedText) { index += 1; openedText = true; yield { type: 'block-start', index, blockType: 'text' } }
        yield { type: 'text-delta', index, text: delta.content }
      }
      if (delta.reasoning_content || delta.reasoning) {
        if (!openedText) { index += 1; openedText = true; yield { type: 'block-start', index, blockType: 'reasoning' } }
        yield { type: 'reasoning-delta', index, text: delta.reasoning_content || delta.reasoning }
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const slot = finishToolCalls.get(tc.index) || { id: tc.id || `call_${tc.index}`, name: '', args: '' }
          if (tc.id) slot.id = tc.id
          if (tc.function && tc.function.name) slot.name += tc.function.name
          if (tc.function && typeof tc.function.arguments === 'string') slot.args += tc.function.arguments
          finishToolCalls.set(tc.index, slot)
          yield {
            type: 'tool-call-delta',
            index: index + 1 + tc.index,
            id: slot.id,
            ...(slot.name ? { name: slot.name } : {}),
            argumentsDelta: (tc.function && tc.function.arguments) || '',
          }
        }
      }
      if (finishReason) {
        if (openedText) { yield { type: 'block-end', index, block: { type: 'text' } }; openedText = false }
        for (const [slotIndex, slot] of finishToolCalls) {
          yield { type: 'block-end', index: index + 1 + slotIndex, block: { type: 'tool-call', id: slot.id, name: slot.name, arguments: slot.args } }
        }
      }
      if (evt.usage) {
        yield {
          type: 'usage',
          usage: {
            input: evt.usage.prompt_tokens || 0,
            output: evt.usage.completion_tokens || 0,
            total: evt.usage.total_tokens || 0,
          },
        }
      }
    }
    if (openedText) yield { type: 'block-end', index, block: { type: 'text' } }
    // contract: usage chunk precedes the terminal finish chunk
    if (!sawUsageEvent) yield { type: 'usage', usage: { input: 0, output: 0, total: 0 } }
    yield { type: 'finish', reason: finishReason === 'length' ? 'length' : finishReason === 'tool_calls' ? 'toolUse' : finishReason === 'aborted' ? 'aborted' : 'stop' }
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}

/**
 * ModelHubPoolAdapter — duck-typed LlmAdapter for the synthetic route.
 * @param deps {{ store: {get,save}, resolveSecret: (ref)=>Promise<string|undefined>, log: (msg)=>void, fetchImpl?: typeof fetch }}
 */
export class ModelHubPoolAdapter {
  constructor(deps) {
    this.deps = deps
    this.state = {} // in-memory runtime stats; reset on restart (documented P0)
  }

  providerInfo(provider) {
    return { id: provider, name: 'Model Hub Pool' }
  }

  providerRetryPolicy() { return undefined }

  listModels() {
    const cfg = this.deps.store.get()
    return Promise.resolve((cfg.models || []).map((m) => ({ id: m.id, name: m.displayName, contextWindow: m.contextWindow })))
      .then((list) => list.concat((cfg.models || []).flatMap((m) => (m.aliases || []).map((a) => ({ id: a, name: `${m.displayName} (alias)` })))))
  }

  async resolveModel(provider, model) {
    const cfg = this.deps.store.get()
    const resolved = resolveRequest(cfg, model)
    if (!resolved) return { provider, id: model, name: model }
    return {
      provider,
      id: resolved.model.id,
      name: resolved.viaAlias ? `${resolved.model.displayName} (${resolved.viaAlias})` : resolved.model.displayName,
      contextWindow: resolved.model.contextWindow,
      maxTokens: resolved.model.maxOutputTokens,
      capabilities: [...resolved.model.capabilities],
    }
  }

  async prepareCall(provider, model, signal) {
    return { model: await this.resolveModel(provider, model, signal), stream: (options) => this.stream(options) }
  }

  /** Route + failover streaming. Never retries forever: bounded by channels × 1. */
  async *stream(options) {
    const cfg = this.deps.store.get()
    const requested = options.model
    const strategy = (cfg.strategy && STRATEGIES.includes(cfg.strategy)) ? cfg.strategy : 'priority'
    const resolved = resolveRequest(cfg, requested)
    if (!resolved) {
      yield {
        type: 'finish',
        reason: 'error',
      }
      throw Object.assign(new Error(`[model-hub] unknown pool model "${requested}" — call model_pool_list for available ids`), { code: 'UNKNOWN_MODEL' })
    }
    const now = Date.now()
    let ordered = orderChannels(resolved.channels, resolved.model.id, strategy, this.state, now)
    if (strategy === 'round-robin' && ordered.length > 1) {
      this._rr = ((this._rr || 0) + 1) % ordered.length
      ordered = ordered.slice(this._rr).concat(ordered.slice(0, this._rr))
    }
    ordered = ordered.slice(0, MAX_ATTEMPTS)
    if (ordered.length === 0) {
      throw Object.assign(new Error('[model-hub] no enabled channel currently serves this model (all disabled, filtered, or cooling down)'), { code: 'NO_CHANNEL' })
    }
    const upstreamId = resolved.model.id
    const attemptsLog = []
    let lastFailure = null
    for (const channel of ordered) {
      let secret
      try { secret = await this.deps.resolveSecret(channel.secretRef) } catch { secret = undefined }
      if (!secret) {
        attemptsLog.push(`${channel.id}: key missing (${channel.secretRef})`)
        recordFailure(this.state, channel.id, upstreamId, { kind: 'auth', cooldownMs: 0 }, 'secret not configured')
        continue
      }
      const payload = buildChatPayload(options, upstreamId)
      let yieldedAny = false
      try {
        for await (const chunk of streamAttempt({
          baseUrl: channel.baseUrl,
          apiKey: secret,
          modelId: upstreamId,
          payload,
          signal: options.signal,
          timeoutMs: channel.timeoutMs || 30000,
        })) {
          if (chunk.type === 'usage') {
            recordSuccess(this.state, channel.id, upstreamId, chunk.usage)
            // re-emit usage so the harness sees real provider usage
            yield chunk
            continue
          }
          yield chunk
        }
        return // success — done routing
      } catch (error) {
        const status = error && error.httpStatus
        const classification = classifyFailure(status || error)
        recordFailure(this.state, channel.id, upstreamId, classification, error.message)
        attemptsLog.push(`${channel.id}: ${classification.kind} (${error.message})`)
        lastFailure = { channel: channel.id, classification, error }
        if (options.signal && options.signal.aborted) throw error
        const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, attemptsLog.length - 1))
        if (backoff > 0) await new Promise((r) => setTimeout(r, backoff))
      }
    }
    // every candidate failed — surface a clear, actionable aggregate error
    const err = new Error(
      `[model-hub] all ${ordered.length} channel(s) failed for "${requested}":\n  ` +
      attemptsLog.join('\n  ') +
      (lastFailure ? `\nlast failure kind: ${lastFailure.classification.kind}` : ''),
    )
    err.code = 'ALL_CHANNELS_FAILED'
    throw err
  }
}

export { normalizeChannel, normalizePoolModel, STRATEGIES }