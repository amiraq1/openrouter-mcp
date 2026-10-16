import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { diffSnapshots } from "../src/index.js";

// ---------- diffSnapshots: تطبيع الأسعار ----------

test("diffSnapshots: اختلاف التنسيق فقط لا يُحسب تغيّر سعر", () => {
  const prev = { "a/x": ["0", "0", 1] };
  const snap = { "a/x": ["0.0", "0.00", 1] };
  const d = diffSnapshots(prev, snap);
  assert.deepEqual(d.price_changed, []);
});

test("diffSnapshots: تغيّر حقيقي في السعر يُرصَد", () => {
  const prev = { "a/x": ["0", "0", 1] };
  const snap = { "a/x": ["0.5", "0", 1] };
  const d = diffSnapshots(prev, snap);
  assert.equal(d.price_changed.length, 1);
  assert.equal(d.price_changed[0].id, "a/x");
});

test("diffSnapshots: القيم المفقودة تُعامَل كمجهولة لا كصفر", () => {
  // null مقابل "0": مجهول ≠ صفر، فيُحسب تغيّرًا (أو يُترك للمراجعة) لا يُتجاهَل
  const prev = { "a/x": [null, null, 1] };
  const snap = { "a/x": ["0", "0", 1] };
  const d = diffSnapshots(prev, snap);
  assert.equal(d.price_changed.length, 1);
});

test("diffSnapshots: جديد/محذوف/تحوّل للمجانية", () => {
  const prev = { "a/old": ["1", "2", 0], "a/keep": ["0", "0", 1], "a/paid": ["1", "2", 0] };
  const snap = { "a/keep": ["0", "0", 1], "a/new": ["0", "0", 1], "a/paid": ["0", "0", 1] };
  const d = diffSnapshots(prev, snap);
  assert.deepEqual(d.new, ["a/new"]);
  assert.deepEqual(d.removed, ["a/old"]);
  assert.deepEqual(d.became_free, ["a/paid"]);
  assert.deepEqual(d.no_longer_free, []);
});

test("diffSnapshots: بلا لقطة سابقة يعيد فرقًا فارغًا", () => {
  const d = diffSnapshots(null, { "a/x": ["0", "0", 1] });
  assert.deepEqual(d, { new: [], removed: [], price_changed: [], became_free: [], no_longer_free: [] });
});
