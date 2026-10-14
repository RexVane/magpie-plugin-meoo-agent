# magpie-plugin-meoo-agent

把 [Meoo（秒悟）](https://meoo.com) 的**建站 Agent** 接成 magpie 的一个 provider。

## 为什么需要这个插件

Meoo 的 Open API **没有 chat completions**。它只有三个概念：

```
建项目  →  起一次 Agent Run  →  订阅 SSE 事件流
```

而客户端说的是 OpenAI 协议。所以中间必须有个翻译层。

这个插件按 magpie 的插件契约（参考 `@magpie-community/opencode-commandcode-auth` 的做法），
在 `auth.loader()` 返回对象的**自定义 `fetch`** 里做翻译：

- 把 magpie 发来的 `POST /chat/completions` 改写成 `POST /projects/{id}/agent/runs`
- 把 SSE 里的 `message.delta` / `message.snapshot` 拼回 chat completion
- 流式（`stream: true`）和非流式都支持

**不占端口、不起独立进程**，整个翻译跑在 magpie 进程内。

## 安装

```bash
cd ~/.config/magpie/plugins
bun add github:RexVane/magpie-plugin-meoo-agent
```

然后在 `~/.config/magpie/plugins.json` 的 `plugins` 数组里加一条：

```json
{ "spec": "magpie-plugin-meoo-agent" }
```

重启 magpie。供应商列表里会出现 **「Meoo 秒悟（建站 Agent）」**（provider id `meoo-agent`），
用认证方式 `API key（meoo.com → 设置 → API 密钥）` 填入你在 Meoo 后台创建的 `meoo_ak_...`。

## 环境变量

在**启动 magpie 之前**设好（插件加载时读取）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MEOO_SPEED_TIER` | `fast` | `fast` / `standard` / `deep`。`deep` 一次 Run 可达数分钟 |
| `MEOO_PROJECT_NAME` | `Magpie Bridge` | Agent 工作所在的项目名，同名复用不重复创建 |
| `MEOO_TIMEOUT_MS` | `600000` | 单次 Run 超时（毫秒） |
| `MEOO_AUTO_ANSWER` | 见源码 | Agent 反问时的自动回答。设为空字符串则不自动回答，直接报错 |
| `MEOO_VERBOSE` | 关 | `1` 打开插件日志，排查用 |

## 已知限制

1. **它不是模型，是「建站 Agent」。** 带着项目上下文、会调工具、会往 Meoo 那个项目里写文件。
   问它通用问题通常也能正常作答，但它本质不是通用 LLM。
2. **慢。** 一次 Run 是分钟级（`deep` 档更久），普通聊天客户端容易超时。
3. **按积分计费，不是 token。** 响应里 `usage.meoo_credits_used` 才是真实消耗，
   `prompt_tokens` / `completion_tokens` 恒为 0（Meoo 协议不返回这些）。
4. **没有 `temperature` / `max_tokens` / `tools` / 函数调用。** Meoo 协议里没有这些字段，
   传了会被静默忽略，所以本插件如实把 `tool_call` 标成 `false`。
5. **没有多轮会话映射。** 每次请求是独立的一次 Run。
6. **流式下偶尔会缺片段。** Meoo 的 `message.snapshot` 实测出现过与已累积 delta 对不上的情况，
   插件会跳过那一帧的增量（非流式调用不受影响，最终全文以 snapshot 为准）。想稳就用 `stream: false`。

## 授权提醒

Meoo 官方文档写明：用户 API Key「不能作为绕过团队系统集成和集成版权益套餐的方式」。
本插件是个人自用性质的适配层，请勿拿它对外提供服务。

## License

MIT
