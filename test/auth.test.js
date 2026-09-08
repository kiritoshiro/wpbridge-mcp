import test from "node:test";
import assert from "node:assert/strict";
import { isAuthorized, safeEqual } from "../lib/auth.js";

const key = "k".repeat(40);

test("bridge authentication accepts Bearer and legacy X-Bridge-Key credentials", () => {
  assert.equal(isAuthorized({ headers: { authorization: `Bearer ${key}` } }, key), true);
  assert.equal(isAuthorized({ headers: { "x-bridge-key": key } }, key), true);
});

test("bridge authentication rejects missing, malformed, and incorrect credentials", () => {
  assert.equal(isAuthorized({ headers: {} }, key), false);
  assert.equal(isAuthorized({ headers: { authorization: `Basic ${key}` } }, key), false);
  assert.equal(isAuthorized({ headers: { authorization: "Bearer wrong" } }, key), false);
  assert.equal(safeEqual("short", "different-length"), false);
});
