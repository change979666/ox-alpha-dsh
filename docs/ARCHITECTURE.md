# Architecture

> 面向贡献者的实现说明。用户文档见 [README](../README.md)。

## 数据流

```
定义（内置 BUILTIN_MODELS / 覆盖目录 OVERRIDES_DIR / model_import 参数）
        │
        │  normalizeModel() / normalizeProvider()
        │  · 字段白名单 + 教学式报错（unknown field / invalid modality / withheld compat…）
        │  · id（API wire 标识）与 name（UI 显示）强制分离
        ▼
pi-ai provider profile
        { apiKeyEnv, displayName, models[], api?, baseURL?, … }
        │
        │  deepPlain() —— 空原型重建
        │  动态插件运行在隔离 realm，普通对象字面量的原型不属于宿主 realm，
        │  settings 服务的 isPlainObject 守卫（proto === Object.prototype || null）
        │  会拒绝；空原型对象在两侧都通过。这是硬约束，不是风格偏好。
        ▼
ctx.settings.update('llm-pi-ai', patch)   ← 官方 settings seam
        · 深合并：providers 按 route 键合并；models 数组整体替换 ⇒ 幂等
        · 即时生效（llm 运行时监听 settings/updated 并原子重注册路由）
        · 持久化到 settings.yaml，重启保留
```

## 关键映射（友好 Schema → pi-ai 真实字段）

| 本项目 Schema | pi-ai/settings 字段 | 说明 |
| --- | --- | --- |
| `provider` | providers 的路由键 | 内置 preset 仅 `openrouter`；其余为自定义路由 |
| `id` | `models[].id` | 发送给 API 的真实 Model ID |
| `name` | `models[].name` | DSH UI 显示名，与 id 无关 |
| `contextWindow` / `maxTokens` | 同名 | 缺省时交给 catalog/DSH 默认值 |
| `input` | `models[].input` | 本构建仅 `text`/`image`；audio/video 会被教学式拒绝 |
| `reasoning: true` | `reasoningEfforts` + 自动 compat | openrouter 路由自动补 `thinkingFormat:'openrouter'`；其他补 `supportsReasoningEffort:true` |
| `reasoning: {level:wire}` | `reasoningEfforts` | 仅 `off` 可为 null |
| `compat.*` | 白名单直通 | withheld 字段（如 openRouterRouting）明确报错 |
| `tools` | 仅元数据 | 工具调用能力由协议决定，无法也不应在 settings 层开关 |
| `aliases[]` | 衍生兄弟路由 `<provider>-<slug>` | 共享同一 apiKeyEnv；同一路由内不允许重复 id，这是官方机制内的别名方案 |

## 回滚语义

- **install**：按定义重建并深合并 → 幂等
- **remove \<route\>**：`settings.mutate unset ['providers', route]` → 整路由移除；重跑 install 即恢复
- **reset-route \<route\>**：用当前定义重建该路由的 models 数组 → 清除手工 import 进去的模型
- 密钥存放在 DSH credentials 服务（本机），删除路由不影响已存密钥

## 安全边界

- 插件从不读取密钥值：只写 `apiKeyEnv` 引用名；检查状态走 `credentials.describe()` 的布尔结果
- 日志/工具输出不含任何密钥材料
- `model_discover` 只访问 OpenRouter 公开 `/models`（无需鉴权），不发送用户数据

## P2/P3 预留设计（未实现）

- **Fallback**：需要 harness 层多模型链路。当前 agent-default-model 为单选，无法安全实现；
  预留接口 = 本插件的 Route 抽象（route→profile 已解耦），未来可挂接官方 fallback 配置节。
- **Router（按任务分流）**：同上，依赖官方 router 能力或 agent-loop 钩子，暂不侵入。
- **测速/推荐**：可通过 `ctx.llm.stream` 计量 TTFT/tokens 实现，但会产生真实调用费用，
  放入 P2；届时以独立 tool 提供，默认关闭。
