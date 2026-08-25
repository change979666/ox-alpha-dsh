# Model Hub for DSH 🔌

**简体中文** | [English](#english)

> DSH Desktop 的第三方模型与 Provider 接入工具 —— 一个插件装好 Ox Alpha，
> 并支持自定义模型、自定义 Provider、健康检查、模型发现与一键回滚。
>
> A lightweight model/provider integration toolkit for DeepSeek Harness (DSH) Desktop.
> One plugin installs Ox Alpha — and any future model you throw at it.

[![License: MIT](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![Platform](https://img.shields.io/badge/platform-DSH%20Desktop-blue)](https://github.com/dataelement/dsh-desktop)
[![No secrets](https://img.shields.io/badge/API%20keys-never%20read-brightgreen)](#-安全--security)

**Install · 三步安装**：clone → 让 Agent 定义并运行插件 → 「设置 → 模型」粘贴 API Key。
**Docs**：[架构说明](./docs/ARCHITECTURE.md) · **Issues**：[提交反馈](https://github.com/change979666/ox-alpha-dsh/issues)

---

## 这是什么 / What is this

[Ox Alpha](https://openrouter.ai/stealth/ox-alpha)（`stealth/ox-alpha`）是 OpenRouter 上的匿名免费模型（1M 上下文、工具调用、推理）。DSH Desktop 内置了 OpenRouter 提供方，但目录里没有它——手动接入要研究协议、上下文参数、Reasoning 格式。

本项目从「Ox Alpha 安装器」升级为 **Model Hub 框架**：

```text
DSH Model Adapter（本插件）
        │
        ├── Provider
        │      ├── OpenRouter        （内置 preset，零配置）
        │      └── 任意 OpenAI 兼容服务（自定义：baseUrl + api + apiKeyEnv）
        │
        └── Model
               ├── id          ← 真正发给 API 的 Model ID
               ├── name        ← DSH UI 显示名（与 id 解耦，可叫"我的免费神机"）
               ├── aliases     ← 别名 = 衍生兄弟路由，快速切换
               ├── contextWindow / maxTokens / input(text·image)
               ├── reasoning   ← OpenRouter 归一化 reasoning:{effort}
               └── tools       ← 能力元数据
```

## Features 特性

- 🐂 **Ox Alpha 开箱即用**：内置定义已核实官方参数（ctx 1,048,576 / out 131,072）
- 🧩 **自定义 Model ID 与显示名**：`model_import` 一条 JSON 即装；id 与 name 强制分离
- 🏷️ **模型别名**：`aliases` 自动生成兄弟路由（如 `openrouter-kimi`），共享同一密钥
- 🌐 **自定义 Provider**：任何 OpenAI Chat Compatibles / Responses / Anthropic Messages 服务
- 🔍 **模型自动发现**：`model_discover` 实时搜索 OpenRouter 公开目录（免密钥），🆓 标记免费模型
- 🩺 **健康检查**：`model_status` 报告路由/密钥/上下文/视觉/推理状态，缺什么一目了然
- ⏪ **可回滚**：`remove` 整路由卸载 · `reset-route` 按定义重建（清掉手工导入）
- 🔁 **幂等安装**：重复运行不产生重复配置
- 🔑 **绝不触碰密钥**：只写引用名；Key 由你在 GUI 亲自粘贴，插件连值都读不到
- 🌏 **中英双语**：文档与工具输出均支持切换

## 快速开始 / Quick start

1. `git clone https://github.com/change979666/ox-alpha-dsh.git`
2. 在 DSH 会话里对 Agent 说：
   > 用 cordis_define 把 `ox-alpha-dsh/plugin/model-hub.host.js` 定义为新插件的 code.host，然后运行
3. **设置 → 模型 → OpenRouter 行 → 粘贴 [OpenRouter Key](https://openrouter.ai/keys)** → 保存完成

验证：让 Agent 调用 `model_status`，看到 `✓ openrouter ... Ox Alpha` 即就绪。

## 工具一览 / Tools

| Tool | 作用 |
| --- | --- |
| `model_status` | 健康检查：路由 ✓/✗、密钥是否配置、每模型的 ctx/vision/reasoning/out |
| `model_hub_manage` | `install`（幂等重装）· `remove <route>`（回滚卸载）· `reset-route <route>`（重建清理）· `list` |
| `model_import` | 导入一个模型定义（JSON 字符串/对象），同 id 幂等跳过；aliases 即时物化 |
| `model_discover` | 搜索 OpenRouter `/models` 公开目录，返回候选供 import |

## 自定义模型示例

```json
{
  "provider": "openrouter",
  "id": "moonshotai/kimi-k2",
  "name": "Kimi K2",
  "aliases": ["kimi"],
  "reasoning": true,
  "tools": true
}
```

自定义 Provider（任何 OpenAI 兼容端点）：

```json
{ "kind": "provider", "id": "my-gateway",
  "displayName": "My Gateway", "baseUrl": "https://api.example.com/v1",
  "api": "openai-completions", "apiKeyEnv": "MY_GATEWAY_API_KEY" }
```

两种方式生效：① 让 Agent 用 `model_import` 导入模型定义；② 把 JSON 放进覆盖目录并设置插件顶部 `OVERRIDES_DIR` 后重跑 install。更多示例见 [`registry/`](./registry)。

## 它写了什么 / What it writes

仅 `settings.yaml` 的 `llm-pi-ai.providers.*` 段（DSH 官方 provider 配置节），通过官方 settings seam 写入——与「设置 → 模型」页面完全同一条路径，即时生效、重启保留。完整字段映射见 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)。

## 🔒 安全 & Security

- 插件**从不读取密钥明文**：只写 `apiKeyEnv` 引用名；检查状态走 credentials 服务的布尔结果
- 密钥存储在 DSH 本机凭据库，由你在 GUI 粘贴；不进代码、不上传、不入日志
- `model_discover` 只访问 OpenRouter 公开端点，不携带也不发送任何用户数据
- ⚠️ **Ox Alpha 隐私提醒**：匿名 stealth Provider，条款声明会保留 prompt/completion（当前不用于训练）。别把公司代码、`.env`、密码投喂进去；正式项目先在测试目录验证

## Roadmap 路线图

- [x] **P0** Provider/Model 解耦框架 · 自定义 id/name · Schema 校验 · 安全边界 · 双语文档
- [x] **P1** 自定义 Provider · OpenAI Compatible · model_status · model_import · 注册表（内置+覆盖目录）· 自动发现
- [ ] **P2** 模型测速（TTFT/tokens）· 模型推荐 · Fallback 链 · 任务路由 —— *Fallback/Router 需要 DSH 官方多模型链路支持，当前版本无法安全实现，已在 ARCHITECTURE.md 预留接口设计*
- [ ] **P3** Cloud · Web Dashboard · 社区模型 Registry

## Screenshots 截图

*TODO — 欢迎 PR 贡献 GIF：安装插件 → 粘贴密钥 → 选择 Ox Alpha → 发送任务。*

## FAQ

**Q: 为什么别名是"另一个路由"？**
DSH 同一 Provider 路由内不允许重复模型 id。别名以兄弟路由形式存在（如 `openrouter-kimi`），复用同一把密钥——这是官方机制内的安全实现。

**Q: audio/video 输入呢？**
当前 DSH 构建的输入模态只有 text/image；定义里写 audio/video 会得到明确报错。这是 Harness 层限制，不是本插件能解决的。

**Q: 和直接改 settings.yaml 有什么区别？**
等价且更安全：走官方 seam 有 Schema 校验（写错当场报错而不是静默失效）、即时热生效、幂等合并，并且不需要你研究 pi-ai 的字段语义。

## License

[MIT](./LICENSE) © 2026 change979666
