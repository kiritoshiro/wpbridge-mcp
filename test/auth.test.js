import test from "node:test";
import assert from "node:assert/strict";
import { bearerToken, isAuthorized, safeEqual } from "../lib/auth.js";

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

test("bearer token parsing trims padding and stays fast on hostile headers", () => {
  assert.equal(bearerToken(`bearer   ${key}  `), key);
  assert.equal(bearerToken(`Bearer ${key} extra`), "");
  assert.equal(bearerToken("Bearer "), "");
  assert.equal(bearerToken(undefined), "");
  const started = process.hrtime.bigint();
  bearerToken(`Bearer${" ".repeat(100_000)}\n`);
  assert.ok(process.hrtime.bigint() - started < 100_000_000n, "parsing took over 100 ms");
});
