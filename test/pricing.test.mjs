import test from "node:test";
import assert from "node:assert/strict";
import { priceVal, perM, isFree, slim } from "../src/index.js";

// انحدار: Number(null) === 0 كان يصنّف نماذج مجهولة السعر كمجانية.

test("priceVal: المفقود يعني غير معروف لا صفرًا", () => {
  assert.equal(priceVal(null), null);
  assert.equal(priceVal(undefined), null);
  assert.equal(priceVal(""), null);
  assert.equal(priceVal("0"), 0);
  assert.equal(priceVal(0), 0);
  assert.equal(priceVal("abc"), null);
  assert.equal(priceVal(-1), null);
});

test("perM: السعر المفقود يبقى null", () => {
  assert.equal(perM(null), null);
  assert.equal(perM(undefined), null);
  assert.equal(perM("0"), 0);
});

test("isFree: نموذج بسعرين مفقودين ليس مجانيًا", () => {
  const m = { id: "x/y", pricing: { prompt: null, completion: null } };
  assert.equal(isFree(m), false);
  const s = slim(m);
  assert.equal(s.free, false);
  assert.equal(s.prompt_per_1m_usd, null);
  assert.equal(s.completion_per_1m_usd, null);
});

test("isFree: سعر صفري صريح يعني مجانيًا", () => {
  assert.equal(isFree({ id: "x/y", pricing: { prompt: "0", completion: "0" } }), true);
  assert.equal(isFree({ id: "x/y", pricing: { prompt: 0, completion: 0 } }), true);
});

test("isFree: لاحقة :free تكفي وحدها", () => {
  assert.equal(isFree({ id: "x/y:free", pricing: {} }), true);
  assert.equal(isFree({ id: "x/y:free" }), true);
});

test("isFree: سعر مختلط (صفر + مفقود) ليس مجانيًا", () => {
  assert.equal(isFree({ id: "x/y", pricing: { prompt: "0", completion: null } }), false);
});
