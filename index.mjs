// meoo-agent — Meoo（秒悟）的建站 Agent，作为 magpie 插件接入。
//
// 为什么需要翻译层：Meoo 的 Open API 没有 chat completions。它只有
//   建项目 → 起一次 Agent Run → 订阅 SSE 事件流
// 这个插件在 auth.loader 返回的 fetch 里做翻译：
//   把 magpie 发来的 chat completion 改写成一次 Run，
//   再把 SSE 里的 message.delta / message.snapshot 拼回 chat completion。
//
// 契约参考 @magpie-community/opencode-commandcode-auth（同样在 fetch 里改协议）。
//
// 已知限制（务必知情）：
//   - 它不是模型，是「建站 Agent」：带项目上下文、会调工具、会往那个项目里写文件
//   - 慢：一次 Run 是分钟级（deep 档更久）
//   - 按积分计费，不是 token
//   - temperature / max_tokens / tools / 函数调用 会被忽略（Meoo 协议里没这些字段）
//   - Meoo 文档写明这把 key「不能作为绕过团队系统集成和集成版权益套餐的方式」

const ID = "meoo-agent";
const API = "https://meoo.com/open/v1";
const CHAT = "@ai-sdk/openai-compatible";
const FELL_BACK = Symbol.for("magpie.fellBack");

const SPEED_TIER   = process.env.MEOO_SPEED_TIER || "fast";      // fast | standard | deep
const PROJECT_NAME = process.env.MEOO_PROJECT_NAME || "Magpie Bridge";
const TIMEOUT_MS   = Number(process.env.MEOO_TIMEOUT_MS || 10 * 60 * 1000);
const AUTO_ANSWER  = process.env.MEOO_AUTO_ANSWER ??
  "请自行选择最合理的方案并直接继续执行，不要向我提问。";
const VERBOSE      = process.env.MEOO_VERBOSE === "1";

const log = (...a) => { if (VERBOSE) console.log("[meoo-agent]", ...a); };

// ---- 模型 ---------------------------------------------------------------------
//
// capabilities 拿不到时的兜底清单。上下文/输出是估算，Meoo 的
// capabilities 不返回这两个字段（DeepSeek-V4-Pro 的 1M/384K 来自官方文档）。
const MODELS = [
  { id: "auto",                        name: "自动选择",        context: 0,       output: 0 },
  { id: "qwen3.8-flash",               name: "Qwen 3.8 Flash",  context: 200_000, output: 64_000 },
  { id: "qwen3.8-max",                 name: "Qwen 3.8 Max",    context: 200_000, output: 64_000 },
  { id: "qwen3.7-max",                 name: "Qwen 3.7 Max",    context: 200_000, output: 64_000 },
  { id: "qwen3.7-plus",                name: "Qwen 3.7 Plus",   context: 200_000, output: 64_000 },
  { id: "DeepSeek/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", context: 200_000, output: 64_000 },
  { id: "deepseek-v4-pro-0813",        name: "DeepSeek V4 Pro",  context: 1_000_000, output: 384_000 },
  { id: "moonshot/kimi-k3",            name: "Kimi K3",          context: 200_000, output: 64_000 },
  { id: "bigmodel/glm-5.3",            name: "GLM-5.3",          context: 200_000, output: 64_000 },
];

function isChatModel(id) { return !/^claude/i.test(id); }

function configModel(m) {
  return {
    name: m.name ?? m.id,
    limit: { context: m.context ?? 0, output: m.output ?? 0 },
    // Meoo 协议里没有 tools，如实标 false，免得客户端以为能函数调用
    tool_call: false,
  };
}

function runtimeModel(m) {
  return {
    id: m.id,
    providerID: ID,
    name: m.name ?? m.id,
    api: { id: m.id, url: API, npm: CHAT },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: m.context ?? 0, output: m.output ?? 0 },
    capabilities: {
      temperature: false,          // Meoo 不收 temperature
      reasoning: false,
      attachment: false,
      toolcall: false,
      input: { text: true, image: false, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
  };
}

// ---- Meoo REST ----------------------------------------------------------------

async function meoo(key, path, { method = "GET", body, headers = {}, signal } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    const detail = json?.detail || json?.message || text.slice(0, 300);
    const err = new Error(`Meoo ${method} ${path} -> ${res.status} ${json?.code ?? ""} ${detail}`.trim());
    err.status = res.status;
    err.traceId = res.headers.get("x-meoo-trace-id");
    throw err;
  }
  return json;
}

// 项目按 key 缓存：同一个 key 复用同名项目，不重复建
const projectByKey = new Map();

function ensureProject(key) {
  const hit = projectByKey.get(key);
  if (hit) return hit;
  const p = (async () => {
    try {
      const list = await meoo(key, "/projects?page_size=100");
      const found = (list?.projects ?? []).find((x) => x.name === PROJECT_NAME && x.type === "web");
      if (found) { log("复用项目", found.url_id); return found.url_id; }
    } catch (e) { log("列项目失败，改为创建：", e.message); }
    const made = await meoo(key, "/projects", { method: "POST", body: { name: PROJECT_NAME, type: "web" } });
    log("已创建项目", made.url_id);
    return made.url_id;
  })();
  p.catch(() => projectByKey.delete(key));
  projectByKey.set(key, p);
  return p;
}

let capCache = { at: 0, key: "", value: null };

async function capabilities(key, projectId) {
  if (capCache.value && capCache.key === key && Date.now() - capCache.at < 5 * 60 * 1000) return capCache.value;
  const cap = await meoo(key, `/projects/${encodeURIComponent(projectId)}/agent/capabilities`);
  capCache = { at: Date.now(), key, value: cap };
  return cap;
}

// ---- SSE ----------------------------------------------------------------------

async function* sseFrames(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let m;
    while ((m = buf.match(/\r?\n\r?\n/))) {
      const frame = buf.slice(0, m.index);
      buf = buf.slice(m.index + m[0].length);
      const parsed = parseFrame(frame);
      if (parsed) yield parsed;
    }
  }
  if (buf.trim()) { const p = parseFrame(buf); if (p) yield p; }
}

function parseFrame(frame) {
  let event = "message";
  const data = [];
  for (const line of frame.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;      // 心跳注释帧
    const c = line.indexOf(":");
    const field = c === -1 ? line : line.slice(0, c);
    let val = c === -1 ? "" : line.slice(c + 1);
    if (val.startsWith(" ")) val = val.slice(1);
    if (field === "event") event = val;
    else if (field === "data") data.push(val);
  }
  if (!data.length) return null;
  const raw = data.join("\n");
  let json = null;
  try { json = JSON.parse(raw); } catch { json = { _raw: raw }; }
  return { event, data: json };
}

// ---- 跑一次 Run ---------------------------------------------------------------

const TERMINAL = new Set(["run.completed", "run.failed", "run.canceled", "run.interrupted"]);

async function handleAction(key, projectId, data, signal) {
  if (!AUTO_ANSWER) {
    throw new Error(`Agent 请求交互，但 MEOO_AUTO_ANSWER 为空：${data?.action?.prompt ?? ""}`);
  }
  if (!data?.action) {
    throw new Error(`Agent 阻塞在无法自动回复的交互上：${data?.detail ?? "unsupported_action"}`);
  }
  const { action_id, kind, prompt, input_schema } = data.action;
  let response;
  if (kind === "confirmation") {
    response = { confirmation: true };
  } else {
    const props = Object.keys(input_schema?.properties ?? {});
    const req = Array.isArray(input_schema?.required) ? input_schema.required : [];
    const use = (req.length ? req : props).slice(0, 4);
    if (!use.length) use.push("answer");
    response = { answers: Object.fromEntries(use.map((k) => [k, AUTO_ANSWER])) };
  }
  log(`自动回复 Action(${kind})：${prompt ?? ""}`.slice(0, 120));
  await meoo(key, `/projects/${encodeURIComponent(projectId)}/agent/action-responses`, {
    method: "POST", body: { action_id, response }, signal,
  });
}

async function drive(key, projectId, runId, signal, onDelta) {
  let text = "";        // 权威全文
  let emitted = "";     // 已经吐出去的
  const seen = new Set();
  let credits = 0n;
  let failure = null;
  let current = runId;

  for (;;) {
    const url = `${API}/projects/${encodeURIComponent(projectId)}/agent/runs/${encodeURIComponent(current)}/events`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${key}`, Accept: "text/event-stream" }, signal });

    if (res.status === 429) {
      const wait = (Number(res.headers.get("retry-after") || 60) + Math.random() * 5) * 1000;
      log(`SSE 限流，${Math.round(wait / 1000)}s 后重连`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) throw new Error(`SSE ${res.status}: ${(await res.text()).slice(0, 200)}`);

    let next = null;
    for await (const { event, data } of sseFrames(res)) {
      if (event === "message.delta" && typeof data.delta === "string") {
        text += data.delta; emitted += data.delta; onDelta?.(data.delta);
      } else if (event === "message.snapshot" && typeof data.content === "string") {
        text = data.content;
        if (data.content.startsWith(emitted)) {
          const add = data.content.slice(emitted.length);
          if (add) { emitted = data.content; onDelta?.(add); }
        } else {
          log("snapshot 与已发送内容不一致，跳过增量修正（非流式不受影响）");
          emitted = data.content;
        }
      } else if (event === "run.usage") {
        if (data.usage_id && !seen.has(data.usage_id)) {
          seen.add(data.usage_id);
          try { credits += BigInt(data.credits_used || "0"); } catch {}
        }
      } else if (event === "run.input_required") {
        await handleAction(key, projectId, data, signal);
      } else if (event === "run.superseded") {
        if (data.current_run_id) next = data.current_run_id;
      } else if (event === "run.failed") {
        failure = data?.error?.message || data?.detail || "run failed";
      } else if (event === "run.interrupted") {
        failure = "run interrupted";
      }
      if (TERMINAL.has(event)) break;
    }
    if (next) { current = next; continue; }
    break;
  }
  if (failure) throw new Error(failure);
  return { text, credits: credits.toString() };
}

// ---- chat completion ⇄ Meoo ----------------------------------------------------

function flatten(messages) {
  return (messages ?? []).map((m) => {
    let c = m.content;
    if (Array.isArray(c)) c = c.map((p) => (p?.type === "text" ? p.text : `[${p?.type ?? "非文本"}]`)).join("\n");
    const label = m.role === "system" ? "系统指令" : m.role === "assistant" ? "助手" : "用户";
    return `[${label}]\n${c ?? ""}`;
  }).join("\n\n");
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(status, message) {
  return jsonResponse({ error: { message, type: "upstream_error" } }, status);
}

async function translate(key, chat, signal) {
  const messages = Array.isArray(chat.messages) ? chat.messages : [];
  if (!messages.length) return errorResponse(400, "messages 不能为空");

  const model = typeof chat.model === "string" && chat.model ? chat.model : "auto";
  const created = Math.floor(Date.now() / 1000);
  const id = "chatcmpl-" + Math.random().toString(36).slice(2, 14);
  const tier = SPEED_TIER;

  const projectId = await ensureProject(key);
  const started = await meoo(key, `/projects/${encodeURIComponent(projectId)}/agent/runs`, {
    method: "POST",
    headers: { "Idempotency-Key": `magpie_${Date.now()}_${Math.random().toString(36).slice(2, 10)}` },
    body: { message: flatten(messages), model, speed_tier: tier },
    signal,
  });
  const runId = started?.run_id ?? started?.id;
  if (!runId) throw new Error(`启动 Run 未返回 run_id：${JSON.stringify(started).slice(0, 200)}`);

  log(`→ run model=${model} tier=${tier} chars=${flatten(messages).length}`);

  const ac = new AbortController();
  if (signal) signal.addEventListener("abort", () => ac.abort(), { once: true });
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  ac.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });

  if (chat.stream === true) {
    const enc = new TextEncoder();
    const chunk = (delta, finish = null, usage) => ({
      id, object: "chat.completion.chunk", created, model,
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(usage ? { usage } : {}),
    });
    const stream = new ReadableStream({
      async start(ctl) {
        try {
          const r = await drive(key, projectId, runId, ac.signal, (d) => {
            ctl.enqueue(enc.encode("data: " + JSON.stringify(chunk({ content: d })) + "\n\n"));
          });
          ctl.enqueue(enc.encode("data: " + JSON.stringify(chunk({}, "stop", {
            prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
            meoo_credits_used: r.credits,
          })) + "\n\n"));
          ctl.enqueue(enc.encode("data: [DONE]\n\n"));
        } catch (e) {
          ctl.enqueue(enc.encode("data: " + JSON.stringify({ error: { message: e.message } }) + "\n\n"));
        }
        ctl.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    });
  }

  const r = await drive(key, projectId, runId, ac.signal, undefined);
  log(`← done credits=${r.credits} chars=${r.text.length}`);
  return jsonResponse({
    id, object: "chat.completion", created, model,
    choices: [{ index: 0, message: { role: "assistant", content: r.text }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
      meoo_credits_used: r.credits,     // 非标准：Meoo 按积分结算
    },
  });
}

// ---- 插件 ---------------------------------------------------------------------

export async function MeooPlugin({ client } = {}) {
  return {
    auth: {
      provider: ID,
      async loader(getAuth) {
        const auth = await getAuth();
        if (auth?.type !== "api" || !auth.key) return {};
        const key = auth.key;
        return {
          baseURL: API,
          apiKey: key,
          headers: {},
          // 只有 chat completions 需要改写；其余请求（如列模型）原样放过
          async fetch(input, init = {}) {
            const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
            if (!/\/chat\/completions$/.test(new URL(url).pathname)) return fetch(input, init);
            const live = (await getAuth()) ?? auth;
            if (!live?.key) return errorResponse(401, "meoo-agent：未登录");
            let chat;
            try {
              const b = init.body ?? (input instanceof Request ? await input.clone().text() : undefined);
              chat = JSON.parse(typeof b === "string" ? b : new TextDecoder().decode(b));
            } catch {
              return errorResponse(400, "meoo-agent：请求体不是 JSON");
            }
            try {
              return await translate(live.key, chat, init.signal);
            } catch (e) {
              const status = e.status >= 400 && e.status < 600 ? e.status : 502;
              return errorResponse(status, e.message);
            }
          },
        };
      },
      methods: [
        { type: "api", label: "API key（meoo.com → 设置 → API 密钥）" },
      ],
    },

    async config(config) {
      config.provider ??= {};
      const was = config.provider[ID] ?? {};
      config.provider[ID] = {
        name: "Meoo 秒悟（建站 Agent）",
        npm: CHAT,
        api: API,
        ...was,
        models: {
          ...Object.fromEntries(MODELS.map((m) => [m.id, configModel(m)])),
          ...(was.models ?? {}),
        },
      };
    },

    provider: {
      id: ID,
      async models(provider, { auth } = {}) {
        const fallback = () => Object.assign(
          Object.fromEntries(MODELS.map((m) => [m.id, runtimeModel(m)])),
          { [FELL_BACK]: true },
        );
        if (auth?.type !== "api" || !auth.key) return fallback();
        try {
          const pid = await ensureProject(auth.key);
          const cap = await capabilities(auth.key, pid);
          const list = cap?.models ?? [];
          if (!list.length) return fallback();
          const known = new Map(MODELS.map((m) => [m.id, m]));
          const out = {};
          for (const m of list) {
            const k = known.get(m.id);
            out[m.id] = runtimeModel({
              id: m.id,
              name: m.name ?? k?.name ?? m.id,
              context: k?.context ?? 0,
              output: k?.output ?? 0,
            });
          }
          return out;
        } catch (e) {
          log("取模型目录失败，用兜底清单：", e.message);
          return fallback();
        }
      },
    },
  };
}

export const _internal = { sseFrames, parseFrame, flatten, MODELS, ID, API };
