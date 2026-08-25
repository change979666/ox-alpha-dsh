# ox-alpha-dsh · Model Hub for DSH

**简体中文** | [English](#english)

> DSH Desktop 的第三方模型接入插件：一键接入 OpenRouter 上的 `stealth/ox-alpha`（Ox Alpha），
> 并提供自定义模型、自定义 Provider、健康检查与模型发现。
>
> A third-party model integration plugin for DSH Desktop: installs `stealth/ox-alpha`
> (Ox Alpha) from OpenRouter, and adds custom-model / custom-provider support,
> health checks and model discovery.

[![License: MIT](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-blue)](https://github.com/topics/dsh-plugin)

**Install 安装**：`dsh plugin --profile <profile> add github:change979666/ox-alpha-dsh`
**Issues**：https://github.com/change979666/ox-alpha-dsh/issues

---

## 这是什么

[Ox Alpha](https://openrouter.ai/stealth/ox-alpha)（`stealth/ox-alpha`）是 OpenRouter 上的一个匿名模型（1,048,576 token 上下文，支持工具调用）。DSH Desktop 内置了 OpenRouter 提供方（llm-pi-ai 适配器），但其内置模型目录不含 Ox Alpha，手动配置需要了解协议、上下文参数与 Reasoning 格式。

本插件做两件事：

1. **安装即接入 Ox Alpha**：通过 DSH 官方 settings seam 写入 `llm-pi-ai.providers.openrouter` 路由和模型定义（与「设置 → 模型」页面同一条写入路径），用户只需粘贴 API Key。
2. **Model Hub 能力**：在 Ox Alpha 之外，支持自定义模型（id 与显示名分离）、自定义 OpenAI 兼容 Provider、模型健康检查、OpenRouter 公开目录搜索与精确回滚。

架构与字段映射见 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)。

## 功能

- 内置 Ox Alpha 定义（参数对照 OpenRouter 公开 API 核实）
- 自定义 Model ID 与显示名（彻底解耦）
- 模型别名（自动生成兄弟路由）
- 自定义 Provider（OpenAI-Compatible / OpenAI Responses / Anthropic Messages 协议）
- 健康检查（路由 / 密钥 / 上下文 / 视觉 / 推理状态）
- 模型发现（搜索 OpenRouter 公开 `/models` 目录，标记免费模型）
- 幂等安装与精确回滚（不覆盖用户已有配置）
- 中英双语工具输出

## 安装

前置条件：已安装 DSH Desktop（自带 `dsh` CLI；插件依赖 harness 内置的 llm-pi-ai 适配器，无需额外依赖）。

```sh
# 从 GitHub 安装到指定 profile
dsh plugin --profile <profile> add github:change979666/ox-alpha-dsh

# 或从本地目录安装
dsh plugin --profile <profile> add ./ox-alpha-dsh
```

本包没有构建脚本，git 安装不需要 pnpm 的构建授权（allowBuilds）。

另一种方式（开发者/动态插件）：仓库内的 `plugin/model-hub.host.js` 与 `plugin/ox-alpha.host.js` 是 cordis_define 动态插件形态的同一功能。**两种方式二选一，不要同时使用**——它们会修改同一个 settings 分节并注册同名工具。

## 配置 OpenRouter

1. 在 [openrouter.ai/keys](https://openrouter.ai/keys) 创建 API Key（`sk-or-v1-…`）。
2. 打开 DSH Desktop → 设置 → 模型 → OpenRouter 行 → 粘贴密钥 → 保存。

也可以通过环境变量 `OPENROUTER_API_KEY` 提供。未配置密钥时，路由已存在但调用会失败；`model_status` 会明确提示密钥缺失。

## 使用 Ox Alpha

配置密钥后，在会话的模型选择器中选择 OpenRouter 下的 **Ox Alpha** 即可；Agent 会话中直接发起任务即可使用。可用 `model_status` 确认状态：

```text
✓ openrouter  key=OPENROUTER_API_KEY  models:
   · Ox Alpha <stealth/ox-alpha> ctx=1048576 vision=✓ reasoning=✓ out=131072
```

## 添加自定义模型

让 Agent 调用 `model_import`，传入 JSON 定义：

```json
{
  "provider": "openrouter",
  "id": "moonshotai/kimi-k2",
  "name": "我的 Kimi",
  "aliases": ["kimi"],
  "reasoning": true,
  "tools": true
}
```

- `id`：实际发送给 API 的 Model ID
- `name`：DSH 界面显示名称（与 id 无关，可任意命名）
- `aliases`：可选；每个别名生成一个兄弟路由（如 `openrouter-kimi`），复用同一密钥引用
- 其余字段：`contextWindow`、`maxTokens`、`input`（`text`/`image`）、`reasoning`（`true`/`false`/级别映射）、`compat`

同 id 重复导入会跳过（幂等）。

## 添加自定义 Provider

任何兼容 OpenAI Chat Completions 的服务都可以接入。把 provider 定义放入覆盖目录（编辑 `plugin/index.js` 顶部的 `OVERRIDES_DIR` 常量指向该目录），然后重跑 install：

```json
{
  "kind": "provider",
  "id": "my-gateway",
  "displayName": "My Gateway",
  "baseUrl": "https://api.example.com/v1",
  "api": "openai-completions",
  "apiKeyEnv": "MY_GATEWAY_API_KEY"
}
```

之后用 `model_import` 向该 Provider 添加模型（`"provider": "my-gateway"`）。协议当前支持 `openai-completions`、`openai-responses`、`anthropic-messages`。

## 工具参考

| 工具 | 用途 |
| --- | --- |
| `model_status` | 健康检查：列出路由与模型，显示密钥是否配置、上下文/视觉/推理/最大输出 |
| `model_hub_manage` | `install`（幂等安装）· `remove <route>`（精确移除）· `reset-route <route>`（恢复定义在位）· `list` |
| `model_import` | 导入一个模型定义（JSON 字符串） |
| `model_discover` | 搜索 OpenRouter 公开目录：`{ "keyword": "free", "limit": 10 }` |

### remove / reset-route 的边界

- 只操作本插件定义的路由与模型；非插件管理的路由会被拒绝并提示。
- 共享路由（如 openrouter）执行 `remove` 时只移除本插件定义的模型，用户手工添加的其他模型会保留；仅当路由内只剩插件模型时才整条移除。
- `reset-route` 只确保本插件定义的模型在位，不会删除任何已有模型。

## Model Pool 模型池

把同一 Provider 的多个 API Key（每个 Key 一个 **Channel**）聚合为一组统一模型。请求按策略自动选择 Channel，遇到 429 / 配额耗尽 / 超时 / 5xx 自动切换到下一个可用 Channel（有最大尝试次数与指数退避，不会请求风暴）。

- 添加渠道：`model_pool_add_channel`（`apiKey` 只写入 DSH 凭据服务，配置文件与日志中永远只有引用名）
- 查看状态：`model_pool_status`（渠道健康、用量计数、最近错误；密钥只显示引用名）
- 列表：`model_pool_list` · 路由预演：`model_pool_route` · 单渠测活：`model_pool_test`
- 使用：会话中直接选择 provider 为 `model-pool` 下的模型或别名
- 策略：`priority`（默认）与 `round-robin` 已实现；`weighted` / `least-used` / `quota-aware` / `expiration-first` 的字段与排序钩子已就位，待 Provider 额度接口接入后启用
- 池配置持久化在 DSH 主目录的 `model-hub/pool.json`（不含任何密钥），插件升级与重装不受影响

English: aggregate multiple API keys ("channels") of the same provider into one unified model set with automatic failover on 429/quota/timeout/5xx, bounded attempts and exponential backoff. Keys live only in the DSH credential store behind references.

## 卸载与升级

- 卸载插件层：`dsh plugin --profile <profile> remove ox-alpha-dsh`。注意这只移除插件本身；已写入 settings 的 provider/model 条目会保留（模型仍可用）。如需一并清理，先执行 `model_hub_manage` 的 `remove`，或手动删除设置中的对应路由。
- 升级：更新本地目录后重新 add（或 git pull 后重启 profile）。安装是幂等的，重复执行不会产生重复配置。

## 权限与数据访问

- 写入：仅 `settings.yaml` 的 `llm-pi-ai.providers.*` 分节（DSH 官方 provider 配置），通过官方 settings seam 完成。
- 读取：settings 同分节；凭据服务（只读布尔状态，判断密钥是否已配置，不读取值）。
- 网络：仅访问 OpenRouter 公开 `GET /models`（无需鉴权）；不发送项目文件、对话内容、环境变量或密钥。
- 不执行与插件功能无关的命令，不动态下载执行代码。

## API Key 如何处理

插件代码从不读取、存储或打印密钥明文。它只在配置中写入引用名（如 `OPENROUTER_API_KEY`），实际密钥由你在 GUI 中粘贴，保存在 DSH 本机凭据服务里。健康检查只询问"某引用是否已配置"（布尔值）。

## Ox Alpha 的隐私风险

Ox Alpha 是匿名第三方提供方。OpenRouter 的 stealth 条款说明其会保留 prompt 与 completion（当前声明不用于训练）。请不要在对话中包含公司代码、`.env`、数据库密码等敏感内容；正式项目建议先在独立测试工作区验证。

## 支持的版本与已知限制

- 需要 DSH Desktop（内置 llm-pi-ai 适配器的版本）。本插件在当前桌面版实测；harness 后续版本若变更 pi-ai 字段语义，以官方文档为准。
- 已知限制：
  - 输入模态仅支持 `text` / `image`（audio/video 取决于 harness，定义中会被拒绝并说明）
  - Fallback / 任务路由需要官方多模型链路，暂未实现
  - 模型定义导入仅支持 JSON（不支持 YAML）
  - 别名以兄弟路由形式实现（同一路由内不允许重复模型 id）

## 开发方式

```text
plugin/index.js            bundle 正式入口（cordis.patch.yml 注册的唯一 host）
plugin/*.host.js           cordis_define 动态插件变体（可选，与 bundle 安装互斥）
registry/                  内置模型/provider 定义的 JSON 事实来源与示例
scripts/validate-plugin.mjs 自检脚本（manifest / 入口 / registry / 密钥扫描 / README 一致性）
docs/ARCHITECTURE.md       架构与字段映射说明
```

```sh
npm install   # 无依赖，秒级完成
npm run check # 结构自检
```

<a id="english"></a>

## English

### What is this

A third-party model integration plugin for DSH Desktop. It installs `stealth/ox-alpha` (Ox Alpha) — an anonymous model on OpenRouter with a 1,048,576-token context window and tool calling — through the official settings seam, and adds a small model-hub toolkit on top: custom models (wire id decoupled from display name), custom OpenAI-compatible providers, health checks, public catalog discovery and precise rollback.

### Install

Prerequisite: DSH Desktop (ships the `dsh` CLI; the plugin relies on the built-in llm-pi-ai adapter, no extra dependencies).

```sh
dsh plugin --profile <profile> add github:change979666/ox-alpha-dsh
# or from a local checkout
dsh plugin --profile <profile> add ./ox-alpha-dsh
```

The package has no build step, so no pnpm build approval is needed.

Alternative (developers): `plugin/model-hub.host.js` / `plugin/ox-alpha.host.js` are the same functionality as cordis_define dynamic-plugin sources. Pick ONE form; do not use both — they patch the same settings section and register the same tool names.

### Configure OpenRouter

Create a key at [openrouter.ai/keys](https://openrouter.ai/keys), then in DSH Desktop open Settings → Models → the OpenRouter row and paste it. Alternatively provide `OPENROUTER_API_KEY` via the environment. Until a key is configured the route exists but calls fail; `model_status` says so explicitly.

### Use Ox Alpha

Pick **Ox Alpha** under OpenRouter in the model picker and start a task. Verify with `model_status`.

### Custom model / custom provider / tools

See the Chinese section above — the tool contracts are identical:

- `model_import` with a JSON definition (`provider`, `id`, `name`, `aliases`, `reasoning`, …); `id` is what gets sent to the API, `name` is only the display label.
- Provider definitions (`kind: "provider"` + `baseUrl` + `api` + `apiKeyEnv`) go into the overrides directory configured by `OVERRIDES_DIR` in `plugin/index.js`, then re-run install.
- `model_status` / `model_hub_manage` / `model_discover` behave as described there.

### Uninstall / upgrade

`dsh plugin --profile <profile> remove ox-alpha-dsh` removes the plugin layer; settings entries stay (models keep working). Run the manage tool's `remove` first if you want the written routes cleaned too. Re-installing after an update is idempotent.

### Permissions & data access

Writes only the `llm-pi-ai.providers.*` section via the official settings seam; reads that section plus boolean credential status; network access is limited to OpenRouter's public unauthenticated `GET /models`. No project files, prompts, environment variables or keys are sent anywhere.

### Privacy note (Ox Alpha)

Ox Alpha is an anonymous third-party provider; OpenRouter's stealth terms state prompts and completions are retained (currently declared as not used for training). Keep secrets and proprietary code out of these conversations.

### Supported versions & known limitations

Requires a DSH Desktop build with the built-in llm-pi-ai adapter (verified against the current desktop release). Known limitations: input modalities are `text`/`image` only; fallback/task-routing needs official multi-model support (not implemented); definitions import as JSON only; aliases are implemented as sibling routes because duplicate model ids within one route are not allowed.

### Development

```sh
npm install
npm run check
```

Layout and design notes: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

## License

[MIT](./LICENSE) © 2026 change979666
