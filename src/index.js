// openrouter-mcp: خادم MCP (Streamable HTTP، ردود JSON) على Cloudflare Workers.
// الأسرار (OPENROUTER_API_KEY, MCP_TOKEN) تأتي من Worker Secrets فقط، ولا تُسجَّل ولا تُرجَع.

const OR = "https://openrouter.ai/api/v1";
const SERVER_INFO = { name: "openrouter-mcp", version: "0.2.0" };
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

// حدود تُفرض في الخادم نفسه:
const PING_DAILY_MAX = 3; // أقصى عدد لاختبارات live_ping باليوم (UTC)
const PING_MIN_REMAINING = 10; // لا اختبار حي إذا بقي أقل من هذا من الحصة المجانية
const PING_MAX_TOKENS = 64;
const LIST_CAP = 50;
const REFRESH_COOLDOWN_MS = 10 * 60 * 1000; // 10 دقائق تبريد لـ refresh=true
const CAT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 دقائق كاش للكتالوج في ذاكرة الـ isolate
const FREE_MODEL_REGEX = /^([\w.-]+\/)?[\w.:-]+:free$/;

const TOOLS = [
  {
    name: "daily_report",
    description:
      "آخر تقرير يومي: نماذج جديدة/محذوفة، تغيّر الأسعار، تحوّل مجاني، ولقطة الحصة. refresh=true يعيد الفحص الآن (مع تبريد 10 دقائق لمنع استهلاك الموارد).",
    inputSchema: {
      type: "object",
      properties: { refresh: { type: "boolean" } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
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
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
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
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
  },
  {
    name: "quota",
    description:
      "الحصة: قسم مالي (usage/limit/effective_budget) وقسم الطلبات المجانية (used/limit/remaining) منفصلان.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
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
    annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false },
  },
];

// ---------- أدوات مساعدة ----------

const today = () => new Date().toISOString().slice(0, 10);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

// السعر المفقود (null/undefined/"") يعني "غير معروف" لا صفرًا:
const priceVal = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const perM = (v) => {
  const n = priceVal(v);
  return n === null ? null : +(n * 1e6).toFixed(4);
};
const isFree = (m) =>
  String(m.id).endsWith(":free") ||
  (priceVal(m.pricing?.prompt) === 0 && priceVal(m.pricing?.completion) === 0);

const slim = (m) => ({
  id: m.id,
  name: m.name ?? null,
  context_length: m.context_length ?? null,
  free: isFree(m),
  prompt_per_1m_usd: perM(m.pricing?.prompt),
  completion_per_1m_usd: perM(m.pricing?.completion),
});
const cap = (a) => ({ total: a.length, items: a.slice(0, LIST_CAP) });

// مقارنة آمنة ضد هجمات التوقيت ولا تسرب طول التوكن إطلاقاً بحساب SHA-256 أولاً
async function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let d = 0;
  for (let i = 0; i < 32; i++) d |= x[i] ^ y[i];
  return d === 0;
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    },
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

// كاش الكتالوج في ذاكرة الـ isolate لتجنب الجلب المتكرر (5 دقائق)
let catCache = { at: 0, data: null };

async function getCatalog(env, forceRefresh = false) {
  if (!forceRefresh && catCache.data && Date.now() - catCache.at < CAT_CACHE_TTL_MS) {
    return catCache.data;
  }
  const r = await orGet(env, "/models", false);
  if (!r.ok || !Array.isArray(r.body?.data)) {
    throw new Error(`catalog_unavailable (HTTP ${r.status})`);
  }
  const data = r.body.data.filter((m) => m && typeof m.id === "string");
  catCache = { at: Date.now(), data };
  return data;
}

// قسم مالي وقسم طلبات مجانية منفصلان مع دعم budgets و effective_budget
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
      effective_budget: d.effective_budget ?? null,
      budgets: d.budgets ?? null,
    },
    free_requests: free,
    is_free_tier: d.is_free_tier ?? null,
  };
}

// تصنيف أخطاء الحصص باستخدام الحقول الرسمية لـ OpenRouter عند توفرها
function classify429(res, body) {
  if (res.status !== 429 && res.status !== 402 && res.status !== 403) return null;
  const meta = body?.error?.metadata;
  if (meta?.limit_source) {
    return `limit_source_${meta.limit_source}`;
  }
  if (meta?.provider_code) {
    return `provider_limit_${meta.provider_code}`;
  }
  const text = JSON.stringify(body ?? {}).toLowerCase();
  if (text.includes("free-models-per-day")) return "daily_free_limit_likely";
  if (res.headers?.get?.("retry-after") || text.includes("rate limit")) {
    return "minute_or_provider_limit_likely";
  }
  return "unclassified";
}

// ---------- الفحص اليومي ----------

// مقارنة لقطتين مع تطبيع الأسعار لتجنب التغيرات الوهمية
function diffSnapshots(prev, snap) {
  const diff = { new: [], removed: [], price_changed: [], became_free: [], no_longer_free: [] };
  if (!prev) return diff;
  for (const id of Object.keys(snap)) {
    const a = prev[id];
    const b = snap[id];
    if (!a) {
      diff.new.push(id);
      continue;
    }
    if (priceVal(a[0]) !== priceVal(b[0]) || priceVal(a[1]) !== priceVal(b[1])) {
      diff.price_changed.push({ id, from: [a[0], a[1]], to: [b[0], b[1]] });
    }
    if (!a[2] && b[2]) diff.became_free.push(id);
    if (a[2] && !b[2]) diff.no_longer_free.push(id);
  }
  for (const id of Object.keys(prev)) if (!snap[id]) diff.removed.push(id);
  return diff;
}

async function runCheck(env) {
  const now = new Date().toISOString();
  let report;
  try {
    const catalog = await getCatalog(env, true);
    const snap = {};
    for (const m of catalog) {
      snap[m.id] = [m.pricing?.prompt ?? null, m.pricing?.completion ?? null, isFree(m) ? 1 : 0];
    }
    const prevRaw = await env.STATE.get("catalog:snapshot");
    const prev = prevRaw ? JSON.parse(prevRaw) : null;
    const diff = diffSnapshots(prev, snap);
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
      // الحصة معلومة ثانوية: فشلها لا يُسقط التقرير
      quota: await getQuota(env).catch((e) => ({
        status: "unavailable",
        error: String(e?.message ?? e).slice(0, 100),
      })),
    };
    // حفظ اللقطة والتقرير الحالي مع أرشيف يومي (30 يوماً)
    await env.STATE.put("catalog:snapshot", JSON.stringify(snap));
    await env.STATE.put("report:latest", JSON.stringify(report));
    await env.STATE.put("report:last_ok", JSON.stringify(report));
    await env.STATE.put("report:last_ok_at", now);
    await env.STATE.put(`report:${today()}`, JSON.stringify(report), { expirationTtl: 30 * 86400 });
    return report;
  } catch (e) {
    // الفشل لا يمحو آخر تقرير ناجح بل يرفقه
    const lastOkRaw = await env.STATE.get("report:last_ok");
    const err = {
      status: "failed",
      generated_at: now,
      error: String(e?.message ?? e).slice(0, 200),
      last_ok_at: await env.STATE.get("report:last_ok_at"),
      last_ok: lastOkRaw ? JSON.parse(lastOkRaw) : null,
    };
    await env.STATE.put("report:last_error", JSON.stringify(err));
    const prevRaw = await env.STATE.get("report:latest");
    return prevRaw ? JSON.parse(prevRaw) : err;
  }
}

// ---------- الأدوات ----------

const handlers = {
  async daily_report(env, a) {
    const raw = await env.STATE.get("report:latest");
    const latest = raw ? JSON.parse(raw) : null;

    if (a.refresh === true) {
      if (latest?.generated_at) {
        const age = Date.now() - new Date(latest.generated_at).getTime();
        if (age < REFRESH_COOLDOWN_MS) {
          return {
            ...latest,
            _cooldown: {
              active: true,
              message: "آخر تقرير أحدث من 10 دقائق، أُعيد التقرير الحالي لمنع استهلاك الموارد المفرط.",
              remaining_seconds: Math.ceil((REFRESH_COOLDOWN_MS - age) / 1000),
            },
          };
        }
      }
      return runCheck(env);
    }
    return latest ?? runCheck(env);
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
      status: "listed_in_catalog",
    };
  },

  async quota(env) {
    return getQuota(env);
  },

  async live_ping(env, a) {
    if (a.confirm !== true) return { refused: "confirm_required" };
    const model = typeof a.model === "string" ? a.model : "";
    if (!FREE_MODEL_REGEX.test(model)) {
      return { refused: "only_free_models_allowed", hint: "يجب أن يكون المعرّف بصيغة provider/model:free" };
    }

    const q = await getQuota(env);
    if (q.status !== "ok" || q.free_requests.status === "unavailable") {
      return { refused: "quota_unreadable", quota_status: q.status };
    }
    if (q.free_requests.remaining < PING_MIN_REMAINING) {
      return { refused: "free_quota_low", remaining: q.free_requests.remaining };
    }

    // العدّاد يُزاد قبل الاستدعاء تحفظاً
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
      return ok({ tools: TOOLS, ttlMs: 86400000 });
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

    // معالجة CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "POST, OPTIONS",
          "access-control-allow-headers": "authorization, content-type",
          "access-control-max-age": "86400",
        },
      });
    }

    if (url.pathname === "/") return new Response("openrouter-mcp: ok");
    if (url.pathname !== "/mcp") return new Response("Not Found", { status: 404 });
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST, OPTIONS" } });
    }
    if (!env?.MCP_TOKEN || !env?.OPENROUTER_API_KEY || !env?.STATE) {
      return json({ error: "server_not_configured" }, 500);
    }
    const auth = request.headers.get("authorization") || "";
    if (!(await safeEqual(auth, `Bearer ${env.MCP_TOKEN}`))) {
      return new Response("Unauthorized", { status: 401, headers: { "www-authenticate": "Bearer" } });
    }
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
    }
    if (Array.isArray(body)) {
      // تنفيذ متسلسل لا متوازٍ لمنع الالتفاف على الحدود، مع سقف أقصى 10
      if (body.length > 10) {
        return json(
          { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Batch too large" } },
          400,
        );
      }
      const rs = [];
      for (const m of body) {
        const r = await handleRpc(m, env);
        if (r) rs.push(r);
      }
      return rs.length ? json(rs) : new Response(null, { status: 202 });
    }
    const r = await handleRpc(body, env);
    return r ? json(r) : new Response(null, { status: 202 });
  },

  async scheduled(event, env, ctx) {
    if (!env?.STATE) {
      console.error("STATE KV binding is missing");
      return;
    }
    ctx.waitUntil(runCheck(env));
  },
};

// تصدير الدوال النقية للاختبارات المحلية (node --test)
export { priceVal, perM, isFree, slim, diffSnapshots, safeEqual, classify429, FREE_MODEL_REGEX };

