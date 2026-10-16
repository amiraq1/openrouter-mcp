import test from "node:test";
import assert from "node:assert/strict";
import worker, { safeEqual, classify429, FREE_MODEL_REGEX } from "../src/index.js";

test("safeEqual: تطابق تام وصامد ضد هجمات التوقيت ولا يسرب الطول", async () => {
  assert.equal(await safeEqual("secret123", "secret123"), true);
  assert.equal(await safeEqual("secret123", "secret124"), false);
  assert.equal(await safeEqual("short", "longer_string_here"), false);
  assert.equal(await safeEqual(null, "str"), false);
  assert.equal(await safeEqual(undefined, undefined), false);
});

test("classify429: يدعم الحقول الرسمية لـ OpenRouter (limit_source و provider_code)", () => {
  assert.equal(
    classify429({ status: 429 }, { error: { metadata: { limit_source: "openrouter_key_limit" } } }),
    "limit_source_openrouter_key_limit"
  );
  assert.equal(
    classify429({ status: 429 }, { error: { metadata: { provider_code: "anthropic_rate_limit" } } }),
    "provider_limit_anthropic_rate_limit"
  );
  assert.equal(
    classify429({ status: 429 }, { error: { message: "Exceeded free-models-per-day quota" } }),
    "daily_free_limit_likely"
  );
  assert.equal(classify429({ status: 200 }, {}), null);
});

test("FREE_MODEL_REGEX: يتحقق من صحة لاحقة :free مع مزود أو بدونه", () => {
  assert.equal(FREE_MODEL_REGEX.test("meta-llama/llama-3-8b:free"), true);
  assert.equal(FREE_MODEL_REGEX.test("google/gemini-2.0-flash:free"), true);
  assert.equal(FREE_MODEL_REGEX.test("model:free"), true);
  assert.equal(FREE_MODEL_REGEX.test("openai/gpt-4o"), false);
  assert.equal(FREE_MODEL_REGEX.test("meta-llama/llama-3:free;rm -rf"), false);
});

test("CORS preflight: طلب OPTIONS يعيد 204 مع ترويسات CORS", async () => {
  const req = new Request("https://example.test/mcp", { method: "OPTIONS" });
  const res = await worker.fetch(req, {});
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.ok(res.headers.get("access-control-allow-methods").includes("POST"));
});

test("daily_report: تبريد refresh يعيد التقرير الأخير إن كان أحدث من 10 دقائق", async () => {
  const store = new Map();
  const now = new Date().toISOString();
  store.set("report:latest", JSON.stringify({ status: "ok", generated_at: now, changes: {} }));

  const env = {
    MCP_TOKEN: "test-token",
    OPENROUTER_API_KEY: "test-key",
    STATE: {
      get: async (k) => store.get(k) ?? null,
      put: async (k, v) => store.set(k, v),
    },
  };

  const req = new Request("https://example.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test-token" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "daily_report", arguments: { refresh: true } },
    }),
  });

  const res = await worker.fetch(req, env);
  assert.equal(res.status, 200);
  const data = await res.json();
  const text = JSON.parse(data.result.content[0].text);
  assert.equal(text._cooldown?.active, true);
  assert.ok(text._cooldown?.remaining_seconds > 0);
});
