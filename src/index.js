// openrouter-mcp: خادم MCP (Streamable HTTP، ردود JSON) على Cloudflare Workers.
// الأسرار (OPENROUTER_API_KEY, MCP_TOKEN) تأتي من Worker Secrets فقط، ولا تُسجَّل ولا تُرجَع.

const OR = "https://openrouter.ai/api/v1";
const SERVER_INFO = { name: "openrouter-mcp", version: "0.1.0" };
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

// حدود تُفرض في الخادم نفسه، لا بتعليمات Muse:
const PING_DAILY_MAX = 3; // أقصى عدد لاختبارات live_ping باليوم (UTC)
const PING_MIN_REMAINING = 10; // لا اختبار حي إذا بقي أقل من هذا من الحصة المجانية
const PING_MAX_TOKENS = 64;
const LIST_CAP = 50;

const TOOLS = [
  {
    name: "daily_report",
    description:
      "آخر تقرير يومي: نماذج جديدة/محذوفة، تغيّر الأسعار، تحوّل مجاني، ولقطة الحصة. refresh=true يعيد الفحص الآن (قراءة فقط، بلا استهلاك حصة).",
    inputSchema: {
      type: "object",
      properties: { refresh: { type: "boolean" } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "models_search",
    description: "بحث في كتالوج OpenRouter مع تصفية بالمجانية والمزوّد.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        free_only: { type: "boolean" },
        provider: { type: "string", description: "مثل google أو nvidia" },
        limit: { type: "integer", minimum: 1, maximum: LIST_CAP },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "model_info",
    description: "معلومات نموذج واحد: السياق والتسعير والمجانية (من الكتالوج فقط).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "quota",
    description:
      "الحصة: قسم مالي (usage/limit) وقسم الطلبات المجانية (used/limit/remaining) منفصلان.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "live_ping",
    description:
      "اختبار حي صغير لنموذج :free واحد. يستهلك من الحصة اليومية المجانية. يتطلب confirm=true، وحده الأقصى اليومي مفروض بالخادم.",
    inputSchema: {
      type: "object",
      properties: { model: { type: "string" }, confirm: { type: "boolean" } },
      required: ["model", "confirm"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
];

// ---------- أدوات مساعدة ----------

const today = () => new Date().toISOString().slice(0, 10);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const perM = (s) => {
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? +(n * 1e6).toFixed(4) : null;
};
const isFree = (m) =>
  String(m.id).endsWith(":free") ||
  (Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0);
const slim = (m) => ({
  id: m.id,
  name: m.name ?? null,
  context_length: m.context_length ?? null,
  free: isFree(m),
  prompt_per_1m_usd: perM(m.pricing?.prompt),
  completion_per_1m_usd: perM(m.pricing?.completion),
});
const cap = (a) => ({ total: a.length, items: a.slice(0, LIST_CAP) });

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

async function orGet(env, path, auth) {
  const headers = auth ? { authorization: `Bearer ${env.OPENROUTER_API_KEY}` } : {};
  const res = await fetch(OR + path, { headers, signal: AbortSignal.timeout(15000) });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* ignore */
  }
  return { status: res.status, ok: res.ok, body };
}

async function getCatalog(env) {
  const r = await orGet(env, "/models", false);
  if (!r.ok || !Array.isArray(r.body?.data)) {
    throw new Error(`catalog_unavailable (HTTP ${r.status})`);
  }
  return r.body.data.filter((m) => m && typeof m.id === "string");
}

// قسم مالي وقسم طلبات مجانية منفصلان، وغياب الحقل يعني "unavailable" لا أصفارًا.
async function getQuota(env) {
  const r = await orGet(env, "/key", true);
  if (r.status === 401) return { status: "auth_failure" };
  const d = r.body?.data;
  if (!r.ok || !d || typeof d !== "object" || Array.isArray(d)) {
    return { status: "unavailable", http_status: r.status };
  }
  const f = d.free_model_daily_requests;
  const free =
    f && num(f.used) !== null && num(f.limit) !== null && num(f.remaining) !== null
      ? {
          used: f.used,
          limit: f.limit,
          remaining: f.remaining,
          percent_used: f.limit > 0 ? +((100 * f.used) / f.limit).toFixed(1) : null,
        }
      : { status: "unavailable" };
  return {
    status: "ok",
    financial: {
      usage: d.usage ?? null,
      usage_daily: d.usage_daily ?? null,
      usage_weekly: d.usage_weekly ?? null,
      usage_monthly: d.usage_monthly ?? null,
      limit: d.limit ?? null,
      limit_remaining: d.limit_remaining ?? null,
      limit_reset: d.limit_reset ?? null,
    },
    free_requests: free,
    is_free_tier: d.is_free_tier ?? null,
  };
}

// تصنيف تقريبي لـ429 (heuristic): لا يُعتمد عليه كحكم نهائي.
function classify429(res, body) {
  if (res.status !== 429) return null;
  const text = JSON.stringify(body ?? {}).toLowerCase();
  if (text.includes("free-models-per-day")) return "daily_free_limit_likely";
  if (res.headers.get("retry-after") || text.includes("rate limit")) {
    return "minute_or_provider_limit_likely";
  }
  return "unclassified";
}

// ---------- الفحص اليومي ----------

async function runCheck(env) {
  const now = new Date().toISOString();
  let report;
  try {
    const catalog = await getCatalog(env);
    const snap = {};
    for (const m of catalog) {
      snap[m.id] = [m.pricing?.prompt ?? null, m.pricing?.completion ?? null, isFree(m) ? 1 : 0];
    }
    const prevRaw = await env.STATE.get("catalog:snapshot");
    const prev = prevRaw ? JSON.parse(prevRaw) : null;
    const diff = { new: [], removed: [], price_changed: [], became_free: [], no_longer_free: [] };
    if (prev) {
      for (const id of Object.keys(snap)) {
        const a = prev[id];
        const b = snap[id];
        if (!a) {
          diff.new.push(id);
          continue;
        }
        if (a[0] !== b[0] || a[1] !== b[1]) {
          diff.price_changed.push({ id, from: [a[0], a[1]], to: [b[0], b[1]] });
        }
        if (!a[2] && b[2]) diff.became_free.push(id);
        if (a[2] && !b[2]) diff.no_longer_free.push(id);
      }
      for (const id of Object.keys(prev)) if (!snap[id]) diff.removed.push(id);
    }
    await env.STATE.put("catalog:snapshot", JSON.stringify(snap));
    report = {
      status: "ok",
      generated_at: now,
      baseline: !prev,
      model_count: catalog.length,
      free_count: catalog.filter(isFree).length,
      changes: {
        new: cap(diff.new),
        removed: cap(diff.removed),
        price_changed: cap(diff.price_changed),
        became_free: cap(diff.became_free),
        no_longer_free: cap(diff.no_longer_free),
      },
      quota: await getQuota(env),
    };
    await env.STATE.put("report:last_ok_at", now);
  } catch (e) {
    report = {
      status: "failed",
      generated_at: now,
      error: String(e?.message ?? e).slice(0, 200),
      last_ok_at: await env.STATE.get("report:last_ok_at"),
    };
  }
  await env.STATE.put("report:latest", JSON.stringify(report));
  return report;
}

// ---------- الأدوات ----------

const handlers = {
  async daily_report(env, a) {
    if (a.refresh === true) return runCheck(env);
    const raw = await env.STATE.get("report:latest");
    return raw ? JSON.parse(raw) : runCheck(env);
  },

  async models_search(env, a) {
    const list = (await getCatalog(env)).map(slim);
    const q = typeof a.query === "string" ? a.query.toLowerCase() : "";
    const prov = typeof a.provider === "string" ? a.provider.toLowerCase().replace(/\/$/, "") : "";
    const limit = Math.min(Math.max(parseInt(a.limit, 10) || 20, 1), LIST_CAP);
    const out = list.filter(
      (m) =>
        (!q || m.id.toLowerCase().includes(q) || String(m.name ?? "").toLowerCase().includes(q)) &&
        (!prov || m.id.toLowerCase().startsWith(prov + "/")) &&
        (a.free_only !== true || m.free),
    );
    return { total_matches: out.length, returned: Math.min(out.length, limit), models: out.slice(0, limit) };
  },

  async model_info(env, a) {
    const id = typeof a.id === "string" ? a.id : "";
    const m = (await getCatalog(env)).find((x) => x.id === id);
    if (!m) return { error: "model_not_found_in_catalog" };
    return {
      ...slim(m),
      description: String(m.description ?? "").slice(0, 500),
      status: "listed_in_catalog", // الكتالوج لا يعطي حالة تشغيل حية
    };
  },

  async quota(env) {
    return getQuota(env);
  },

  async live_ping(env, a) {
    if (a.confirm !== true) return { refused: "confirm_required" };
    const model = typeof a.model === "string" ? a.model : "";
    if (!model.endsWith(":free")) return { refused: "only_free_models_allowed" };

    const q = await getQuota(env);
    if (q.status !== "ok" || q.free_requests.status === "unavailable") {
      return { refused: "quota_unreadable", quota_status: q.status };
    }
    if (q.free_requests.remaining < PING_MIN_REMAINING) {
      return { refused: "free_quota_low", remaining: q.free_requests.remaining };
    }

    // العدّاد يُزاد قبل الاستدعاء (تحفظًا). KV غير ذرّي تمامًا، وهذا مقبول لاستخدام متقطع.
    const key = `ping:${today()}`;
    const used = parseInt((await env.STATE.get(key)) || "0", 10);
    if (used >= PING_DAILY_MAX) return { refused: "daily_ping_cap_reached", cap: PING_DAILY_MAX };
    await env.STATE.put(key, String(used + 1), { expirationTtl: 172800 });

    const t0 = Date.now();
    const res = await fetch(`${OR}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: PING_MAX_TOKENS,
        messages: [{ role: "user", content: "Reply with the single word: ok" }],
      }),
      signal: AbortSignal.timeout(30000),
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* ignore */
    }
    const latency_ms = Date.now() - t0;
    if (!res.ok) {
      return {
        ok: false,
        http_status: res.status,
        limit_type: classify429(res, body),
        error: String(body?.error?.message ?? "").slice(0, 200),
        latency_ms,
        pings_today: used + 1,
      };
    }
    const c = body?.choices?.[0];
    return {
      ok: true,
      http_status: 200,
      latency_ms,
      finish_reason: c?.finish_reason ?? null,
      reply_preview: String(c?.message?.content ?? "").slice(0, 100),
      usage: body?.usage ?? null,
      pings_today: used + 1,
      note: "عدّاد الحصة عند المزوّد يتأخر نحو دقيقة",
    };
  },
};

// ---------- JSON-RPC / MCP ----------

async function handleRpc(msg, env) {
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return { jsonrpc: "2.0", id: msg?.id ?? null, error: { code: -32600, message: "Invalid Request" } };
  }
  if (!("id" in msg)) return null; // إشعارات (notifications): لا ردّ
  const ok = (result) => ({ jsonrpc: "2.0", id: msg.id, result });
  const err = (code, message) => ({ jsonrpc: "2.0", id: msg.id, error: { code, message } });

  switch (msg.method) {
    case "initialize": {
      const asked = msg.params?.protocolVersion;
      return ok({
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS });
    case "tools/call": {
      const name = msg.params?.name;
      const raw = msg.params?.arguments;
      const args = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
      if (typeof name !== "string" || !Object.hasOwn(handlers, name)) {
        return err(-32602, "Unknown tool");
      }
      try {
        const out = await handlers[name](env, args);
        return ok({ content: [{ type: "text", text: JSON.stringify(out) }] });
      } catch (e) {
        return ok({
          isError: true,
          content: [{ type: "text", text: JSON.stringify({ error: String(e?.message ?? e).slice(0, 200) }) }],
        });
      }
    }
    default:
      return err(-32601, "Method not found");
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/") return new Response("openrouter-mcp: ok");
    if (url.pathname !== "/mcp") return new Response("Not Found", { status: 404 });
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
    }
    if (!env.MCP_TOKEN || !env.OPENROUTER_API_KEY || !env.STATE) {
      return json({ error: "server_not_configured" }, 500);
    }
    const auth = request.headers.get("authorization") || "";
    if (!safeEqual(auth, `Bearer ${env.MCP_TOKEN}`)) {
      return new Response("Unauthorized", { status: 401, headers: { "www-authenticate": "Bearer" } });
    }
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
    }
    if (Array.isArray(body)) {
      const rs = (await Promise.all(body.map((m) => handleRpc(m, env)))).filter(Boolean);
      return rs.length ? json(rs) : new Response(null, { status: 202 });
    }
    const r = await handleRpc(body, env);
    return r ? json(r) : new Response(null, { status: 202 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCheck(env));
  },
};
