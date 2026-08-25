/**
 * Ox Alpha quick installer for DSH 🐂 (legacy single-model edition)
 * =============================================================================
 * ⭐ v0.2 起推荐使用 ../model-hub.host.js —— 多 Provider / 多模型 / 自定义模型
 *    框架版。本文件保留以兼容早期 README 链接：只装 Ox Alpha 一个模型。
 *    Since v0.2 prefer model-hub.host.js; this file stays for the original
 *    README link and installs exactly one model: stealth/ox-alpha.
 *
 * Run once → Settings → Models → OpenRouter → paste your sk-or-v1-… key.
 * Model facts verified against https://openrouter.ai/api/v1/models:
 *   context 1,048,576 · max output 131,072 · text+image input · reasoning via
 *   OpenRouter-normalized `reasoning:{effort}` · tool calling supported.
 */

const MODEL = {
  id: 'stealth/ox-alpha',
  name: 'Ox Alpha',
  contextWindow: 1048576,
  maxTokens: 131072,
  input: ['text', 'image'],
  reasoningEfforts: {
    minimal: 'minimal',
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: 'high',
    max: 'high',
  },
  compat: {
    thinkingFormat: 'openrouter',
    supportsReasoningEffort: true,
  },
}

/** Null-prototype rebuild — required to pass the settings service' cross-realm plain-object guard. */
function deepPlain(value) {
  if (Array.isArray(value)) return value.map(deepPlain)
  if (value !== null && typeof value === 'object') {
    const out = Object.create(null)
    for (const key of Object.keys(value)) out[key] = deepPlain(value[key])
    return out
  }
  return value
}

return {
  inject: ['settings'],
  apply(ctx) {
    const patch = deepPlain({
      providers: {
        openrouter: {
          apiKeyEnv: 'OPENROUTER_API_KEY',
          displayName: 'OpenRouter',
          models: [MODEL],
        },
      },
    })

    ctx.settings
      .update('llm-pi-ai', patch)
      .then(() => {
        console.log('[ox-alpha] installed: openrouter route + stealth/ox-alpha.')
        console.log('[ox-alpha] next step: Settings → Models → OpenRouter → paste your sk-or-v1-… key.')
      })
      .catch((error) => console.error('[ox-alpha] install failed: ' + (error && error.message ? error.message : String(error))))

    harness.registerTool(
      ctx,
      harness.defineTool({
        name: 'oxalpha_status',
        description:
          '查看 Ox Alpha (OpenRouter) 在本机 DSH 的安装状态：路由是否已写入、API 密钥是否已配置。 | Check the local Ox Alpha (OpenRouter) install status in DSH: route installed? API key configured?',
        parameters: {},
        output: {
          schema: { type: 'object', additionalProperties: true },
          render(_args, value) {
            const mark = (v) => (v === true ? '✅' : v === false ? '❌' : '❔')
            return [{ type: 'text', text: `Ox Alpha 🐂  route ${mark(value.installed)}  apiKey ${mark(value.keyConfigured)}\n${value.hint || ''}` }]
          },
        },
        async execute() {
          let installed = false
          let models = []
          try {
            const value = ctx.settings.get('llm-pi-ai')
            const openrouter = value && value.providers ? value.providers.openrouter : undefined
            installed = openrouter !== undefined
            models = openrouter && Array.isArray(openrouter.models) ? openrouter.models.map((m) => m.id) : []
          } catch {}
          let keyConfigured = null
          const credentials = ctx.get('credentials')
          if (credentials !== undefined) {
            try {
              const info = await credentials.describe('OPENROUTER_API_KEY')
              keyConfigured = Boolean(info && (info.configured ?? info.present))
            } catch {}
          }
          const hint =
            installed === false
              ? '路由未安装？重启一次本插件即可。'
              : keyConfigured === false
                ? '最后一步：设置 → 模型 → OpenRouter 行，粘贴你的 sk-or-v1-… 密钥并保存。'
                : '一切就绪，模型选择器里选 Ox Alpha 即可使用。'
          return { installed, keyConfigured, models, hint }
        },
      }),
    )
  },
}
