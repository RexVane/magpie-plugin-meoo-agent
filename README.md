# magpie-plugin-meoo-agent

[English](#english) · [简体中文](#简体中文)

---

## English

Bring [Meoo (秒悟)](https://meoo.com)'s **app-building Agent** into magpie as a provider.

### Why this exists

Meoo's Open API has **no chat completions endpoint**. It only understands three things:

```
create project  →  start an Agent Run  →  subscribe to an SSE event stream
```

Clients, on the other hand, speak the OpenAI protocol. Something has to translate.

Following magpie's plugin contract (the same approach
[`@magpie-community/opencode-commandcode-auth`](https://github.com/magpie-community/plugins) takes),
this plugin does the translation inside the **custom `fetch`** returned by `auth.loader()`:

- rewrites incoming `POST /chat/completions` into `POST /projects/{id}/agent/runs`
- reassembles `message.delta` / `message.snapshot` from the SSE stream back into a chat completion
- supports both streaming (`stream: true`) and non-streaming

**No port, no sidecar process** — the whole translation runs inside magpie.

### Install

Discovered on GitHub via the [`magpie-plugin`](https://github.com/topics/magpie-plugin) topic.
Inside magpie, open the **unofficial plugins (GitHub)** list and install it, or add it manually:

```bash
cd ~/.config/magpie/plugins
bun add github:RexVane/magpie-plugin-meoo-agent
```

then add to `~/.config/magpie/plugins.json`:

```json
{ "spec": "magpie-plugin-meoo-agent" }
```

**Provider id:** `meoo-agent` · **Auth:** `API key` — create a `meoo_ak_...` key at
[meoo.com](https://meoo.com) → 设置 → API 密钥.

### Speed tiers as model variants

Meoo's Run endpoint takes a `speed_tier` field (`fast` = lowest latency /
`standard` = balanced / `deep` = more reasoning, slower and costlier).
This plugin exposes it as **model variants**, so you pick it from the model dropdown
instead of configuring an environment variable:

```
qwen3.8-flash@fast        lowest latency
qwen3.8-flash@standard    balanced
qwen3.8-flash@deep        deepest reasoning
```

Every upstream model gets all three, so the model count is `upstream × 3`
(14 × 3 = **42** in practice).

The plugin strips the `@tier` suffix before calling Meoo, and keeps the full
variant name in the response's `model` field.

A model id without a suffix falls back to the default tier
(`fast`, overridable with `MEOO_SPEED_TIER`).

### Environment variables

All optional. Read when the plugin loads, i.e. **before magpie starts**.

| Variable | Default | Purpose |
| --- | --- | --- |
| `MEOO_SPEED_TIER` | `fast` | **Fallback only** — used when a model id carries no `@tier` |
| `MEOO_PROJECT_NAME` | `Magpie Bridge` | Meoo project the Agent works in; reused when it already exists |
| `MEOO_TIMEOUT_MS` | `600000` | Per-Run timeout in milliseconds |
| `MEOO_AUTO_ANSWER` | see source | Auto-reply when the Agent asks a question. Empty string = fail instead of auto-answering |
| `MEOO_VERBOSE` | off | `1` turns on plugin logging |

### Known limitations

1. **It is not a model — it is an app-building Agent.** It carries project context,
   calls tools, and writes files into that Meoo project. It will usually answer a
   general question fine, but it is not a general-purpose LLM.
2. **Slow.** One Run takes minutes (`deep` longer). Ordinary chat clients may time out.
3. **Billed in credits, not tokens.** The real cost is `usage.meoo_credits_used`;
   `prompt_tokens` / `completion_tokens` are always 0 because Meoo's protocol
   does not report them.
4. **No `temperature` / `max_tokens` / `tools` / function calling.** Meoo's protocol
   has no such fields, they are silently ignored — hence `tool_call` is reported as `false`.
5. **No multi-turn conversation mapping.** Each request is an independent Run.
6. **Streaming may occasionally drop a fragment.** `message.snapshot` has been observed
   arriving out of sync with the accumulated deltas; the plugin skips that frame's
   increment (non-streaming is unaffected — the final text follows the snapshot).
   Use `stream: false` if you want to be safe.

### Authorization note

Meoo's own documentation states that a user API key "must not be used as a way to
bypass team system integration or the integration-tier entitlement package".
This plugin is a personal-use adapter. Please do not run it as a service for others.

### License

MIT

---

## 简体中文

把 [Meoo（秒悟）](https://meoo.com) 的**建站 Agent** 接成 magpie 的一个 provider。

### 为什么需要这个插件

Meoo 的 Open API **没有 chat completions**。它只有三个概念：

```
建项目  →  起一次 Agent Run  →  订阅 SSE 事件流
```

而客户端说的是 OpenAI 协议。所以中间必须有个翻译层。

这个插件按 magpie 的插件契约（与
[`@magpie-community/opencode-commandcode-auth`](https://github.com/magpie-community/plugins) 同样的做法），
在 `auth.loader()` 返回对象的**自定义 `fetch`** 里做翻译：

- 把 magpie 发来的 `POST /chat/completions` 改写成 `POST /projects/{id}/agent/runs`
- 把 SSE 里的 `message.delta` / `message.snapshot` 拼回 chat completion
- 流式（`stream: true`）和非流式都支持

**不占端口、不起独立进程**，整个翻译跑在 magpie 进程内。

### 安装

通过 GitHub 的 [`magpie-plugin`](https://github.com/topics/magpie-plugin) 标签被发现。
在 magpie 里打开**非官方插件（GitHub）**列表安装，或手动加：

```bash
cd ~/.config/magpie/plugins
bun add github:RexVane/magpie-plugin-meoo-agent
```

然后在 `~/.config/magpie/plugins.json` 里加：

```json
{ "spec": "magpie-plugin-meoo-agent" }
```

**Provider id：** `meoo-agent` · **认证方式：** `API key` —— 在
[meoo.com](https://meoo.com) → 设置 → API 密钥 建一把 `meoo_ak_...`。

### 档位：做成模型变体

Meoo 的起 Run 接口有个 `speed_tier` 字段（`fast` 优先低延迟 /
`standard` 平衡 / `deep` 更多推理但更慢更费）。
本插件把它**做成模型变体**，从模型下拉框里直接选，不用配环境变量：

```
qwen3.8-flash@fast        快速
qwen3.8-flash@standard    标准
qwen3.8-flash@deep        深度
```

每个上游模型都有这三个变体，所以模型数 = 上游模型数 × 3（实测 14 × 3 = **42 个**）。

插件在起 Run 前会把 `@档位` 后缀剥掉再发给 Meoo，响应里的 `model` 字段仍保留完整变体名。

没带 `@档位` 的模型 ID 走兜底档（默认 `fast`，可用 `MEOO_SPEED_TIER` 覆盖）。

### 环境变量

都是可选的，在**启动 magpie 之前**设好（插件加载时读取）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MEOO_SPEED_TIER` | `fast` | **仅兜底** —— 模型 ID 没带 `@档位` 时才用 |
| `MEOO_PROJECT_NAME` | `Magpie Bridge` | Agent 工作所在的项目名，同名复用不重复创建 |
| `MEOO_TIMEOUT_MS` | `600000` | 单次 Run 超时（毫秒） |
| `MEOO_AUTO_ANSWER` | 见源码 | Agent 反问时的自动回答。设为空字符串则不自动回答，直接报错 |
| `MEOO_VERBOSE` | 关 | `1` 打开插件日志，排查用 |

### 已知限制

1. **它不是模型，是「建站 Agent」。** 带着项目上下文、会调工具、会往 Meoo 那个项目里写文件。
   问它通用问题通常也能正常作答，但它本质不是通用 LLM。
2. **慢。** 一次 Run 是分钟级（`deep` 档更久），普通聊天客户端容易超时。
3. **按积分计费，不是 token。** 真实消耗看 `usage.meoo_credits_used`；
   `prompt_tokens` / `completion_tokens` 恒为 0，因为 Meoo 协议不返回这些。
4. **没有 `temperature` / `max_tokens` / `tools` / 函数调用。** Meoo 协议里没有这些字段，
   传了会被静默忽略，所以本插件如实把 `tool_call` 标成 `false`。
5. **没有多轮会话映射。** 每次请求是独立的一次 Run。
6. **流式下偶尔会缺片段。** Meoo 的 `message.snapshot` 实测出现过与已累积 delta 对不上的情况，
   插件会跳过那一帧的增量（非流式调用不受影响，最终全文以 snapshot 为准）。
   想稳就用 `stream: false`。

### 授权提醒

Meoo 官方文档写明：用户 API Key「不能作为绕过团队系统集成和集成版权益套餐的方式」。
本插件是个人自用性质的适配层，请勿拿它对外提供服务。

### License

MIT
