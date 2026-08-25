# Ox Alpha for DSH 🐂

**简体中文** | [English](#english)

> 一个 DSH 插件装好 Ox Alpha：运行一次 → 「设置 → 模型」里粘贴 OpenRouter 密钥 → 完成。
> One DSH plugin for Ox Alpha: run once → paste your OpenRouter key in Settings → Models → done.

[![License: MIT](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

---

## 中文

### 这是什么

[Ox Alpha](https://openrouter.ai/stealth/ox-alpha)（`stealth/ox-alpha`）是 OpenRouter 上的匿名免费模型（1M 上下文、支持工具调用与推理）。DSH Desktop 内置了 OpenRouter 提供方，但模型目录里没有 Ox Alpha——手动配置要研究协议、上下文参数、推理格式……

本插件把这一切打包成一次安装：

- ✅ 通过官方 settings seam 写入 `llm-pi-ai.providers.openrouter` 路由（与「设置→模型」页面同一条写入路径，立即生效、重启保留）
- ✅ 自动填好全部模型参数：上下文 1,048,576 / 最大输出 131,072 / text+image 输入 / OpenRouter 归一化推理（`reasoning:{effort}`）/ 工具调用
- ✅ 幂等：重复运行不会产生重复或冲突配置
- ✅ 附带 `oxalpha_status` 工具：一句话回答「还差什么」（路由装了吗？密钥配了吗？）
- 🔑 **不碰你的密钥**：插件只写配置；密钥由你在 GUI 里亲自粘贴

### 安装（三步）

1. 把本仓库 clone 到本机，打开 [`plugin/ox-alpha.host.js`](./plugin/ox-alpha.host.js)（无需改任何内容）。
2. 在 DSH 会话里对 Agent 说：

   > 用 cordis_define 把 `…\ox-alpha-dsh\plugin\ox-alpha.host.js` 定义为新插件的 code.host，然后 cordis_run 运行

3. 打开 **设置 → 模型 → OpenRouter 行**，粘贴你的 [OpenRouter API Key](https://openrouter.ai/keys)（`sk-or-v1-…`），保存。

完成后随时可以让 Agent 调用 `oxalpha_status` 确认状态。

### 它写了什么

`settings.yaml` 的 `llm-pi-ai.providers.openrouter` 段：

```yaml
openrouter:
  apiKeyEnv: OPENROUTER_API_KEY
  displayName: OpenRouter
  models:
    - id: stealth/ox-alpha
      name: Ox Alpha
      contextWindow: 1048576
      maxTokens: 131072
      input: [text, image]
      reasoningEfforts: { minimal: minimal, low: low, medium: medium, high: high, xhigh: high, max: high }
      compat: { thinkingFormat: openrouter, supportsReasoningEffort: true }
```

卸载：在「设置 → 模型」里删除该提供方，或直接编辑 settings.yaml 删除 `openrouter:` 段。已有其他 OpenRouter 模型需求？在 models 列表里照格式追加即可。

### ⚠️ 隐私提醒

Ox Alpha 是匿名第三方 Provider。OpenRouter 的 stealth 条款说明会**保留 prompt 与 completion**（当前声明不用于训练）。不要在对话中投放公司代码、`.env`、数据库密码等敏感内容；正式项目请先用测试目录验证。

---

<a id="english"></a>

## English

### What is this

[Ox Alpha](https://openrouter.ai/stealth/ox-alpha) (`stealth/ox-alpha`) is an anonymous free model on OpenRouter (1M context, tool calling & reasoning). DSH Desktop ships an OpenRouter provider but its model catalog does not include Ox Alpha — configuring it by hand means researching wire protocols, context parameters and reasoning formats.

This plugin packages all of that into one install:

- ✅ Writes the `llm-pi-ai.providers.openrouter` route through the official settings seam — the same write path as the web Models page; effective immediately and durable across restarts
- ✅ Fills in every model fact: context 1,048,576 / max output 131,072 / text+image input / OpenRouter-normalized reasoning (`reasoning:{effort}`) / tool calling
- ✅ Idempotent: re-running never duplicates or conflicts
- ✅ Ships the `oxalpha_status` tool: one call answers "what's still missing?" (route installed? key configured?)
- 🔑 **Never touches your key**: the plugin only writes config; you paste the key yourself in the GUI

### Install (three steps)

1. Clone this repo, open [`plugin/ox-alpha.host.js`](./plugin/ox-alpha.host.js) (no edits needed).
2. In a DSH session, tell your agent:

   > Define `…\ox-alpha-dsh\plugin\ox-alpha.host.js` as a new plugin's code.host via cordis_define, then run it with cordis_run

3. Open **Settings → Models → OpenRouter row**, paste your [OpenRouter API key](https://openrouter.ai/keys) (`sk-or-v1-…`), save.

Anytime later, ask your agent to call `oxalpha_status` to confirm everything is ready.

### What it writes

The `llm-pi-ai.providers.openrouter` section of `settings.yaml`:

```yaml
openrouter:
  apiKeyEnv: OPENROUTER_API_KEY
  displayName: OpenRouter
  models:
    - id: stealth/ox-alpha
      name: Ox Alpha
      contextWindow: 1048576
      maxTokens: 131072
      input: [text, image]
      reasoningEfforts: { minimal: minimal, low: low, medium: medium, high: high, xhigh: high, max: high }
      compat: { thinkingFormat: openrouter, supportsReasoningEffort: true }
```

Uninstall: remove the provider row in Settings → Models, or delete the `openrouter:` section from settings.yaml. Want more OpenRouter models later? Append entries to the models list following the same shape.

### ⚠️ Privacy note

Ox Alpha is an anonymous third-party provider. OpenRouter's stealth terms state that prompts and completions are **retained** by the provider (currently declared as not used for training). Keep company code, `.env` files and credentials out of these conversations; validate real projects in a throwaway workspace first.

---

## License

[MIT](./LICENSE) © 2026 change979666
