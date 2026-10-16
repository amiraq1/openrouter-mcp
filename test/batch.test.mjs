import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

// محاكاة بيئة الـWorker: KV على Map، وfetch وهمي لـ OpenRouter.
function mockEnv() {
  const store = new Map();
  return {
    MCP_TOKEN: "test-token",
    OPENROUTER_API_KEY: "test-key",
    STATE: {
      get: async (k) => (store.has(k) ? store.get(k) : null),
      put: async (k, v) => {
        store.set(k, v);
      },
    },
    _store: store,
  };
}

function mockFetch() {
  const nullHeaders = { get: () => null };
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/api/v1/key")) {
      return {
        ok: true,
        status: 200,
        headers: nullHeaders,
        json: async () => ({
          data: { free_model_daily_requests: { used: 0, limit: 50, remaining: 50 } },
        }),
      };
    }
    if (u.includes("/api/v1/chat/completions")) {
      return {
        ok: true,
        status: 200,
        headers: nullHeaders,
        json: async () => ({
          choices: [{ finish_reason: "stop", message: { content: "ok" } }],
          usage: {},
        }),
      };
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
}

async function post(env, body) {
  const req = new Request("https://example.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test-token" },
    body: JSON.stringify(body),
  });
  return worker.fetch(req, env);
}

function pingCall(id) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "live_ping", arguments: { model: "x:free", confirm: true } },
  };
}

function toolText(rpcRes) {
  return JSON.parse(rpcRes.result.content[0].text);
}

test("الدفعة الأكبر من 10 تُرفَض", async () => {
  mockFetch();
  const env = mockEnv();
  const batch = Array.from({ length: 11 }, (_, i) => ({
    jsonrpc: "2.0",
    id: i + 1,
    method: "ping",
  }));
  const res = await post(env, batch);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.message, "Batch too large");
});

test("الدفعة تحافظ على ترتيب الردود", async () => {
  mockFetch();
  const env = mockEnv();
  const batch = [
    { jsonrpc: "2.0", id: 1, method: "ping" },
    { jsonrpc: "2.0", id: 2, method: "ping" },
  ];
  const res = await post(env, batch);
  const arr = await res.json();
  assert.deepEqual(arr.map((r) => r.id), [1, 2]);
});

test("انحدار: 4 استدعاءات live_ping في دفعة واحدة — الرابع يُرفَض", async () => {
  // مع التنفيذ المتسلسل يرى كل استدعاء كتابة سابقه، فيصمد حدّ 3/يوم.
  // (مع Promise.all القديم كانت الأربعة تنجح معًا بتجاوز الحد.)
  mockFetch();
  const env = mockEnv();
  const res = await post(env, [pingCall(1), pingCall(2), pingCall(3), pingCall(4)]);
  const arr = await res.json();
  assert.equal(arr.length, 4);
  const texts = arr.map(toolText);
  assert.equal(texts[0].ok, true);
  assert.equal(texts[1].ok, true);
  assert.equal(texts[2].ok, true);
  assert.equal(texts[3].refused, "daily_ping_cap_reached");
});
