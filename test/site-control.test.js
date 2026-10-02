import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createSiteControlHandler } from "../lib/site-control.js";

const controlKey = "c".repeat(64);
const cfg = { wpUrl: "https://example.test", maxBodyBytes: 10000 };
const security = { rateLimited: () => false };

function request(method, url, token, body) {
  return Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), {
    method, url, headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

function response() {
  const headers = {};
  return {
    statusCode: 200, headers, body: "",
    setHeader(key, value) { headers[key.toLowerCase()] = value; },
    writeHead(status, extra) { this.statusCode = status; Object.assign(headers, extra); return this; },
    end(text) { this.body = text || ""; return this; },
  };
}

test("site-control routes require separate credentials", async () => {
  let called = false;
  const handler = createSiteControlHandler({ cfg, security, controlKey,
    controlUsername: "control", controlAppPassword: "app-password",
    fetchImpl: async () => { called = true; return new Response("{}"); } });
  const res = response();
  await handler(request("GET", "/v1/site-control/site", "wrong"), res);
  assert.equal(res.statusCode, 401);
  assert.equal(called, false);
  const unconfigured = createSiteControlHandler({ cfg, security, controlKey: "", controlUsername: "", controlAppPassword: "" });
  const res2 = response();
  await unconfigured(request("GET", "/v1/site-control/site", controlKey), res2);
  assert.equal(res2.statusCode, 503);
});

test("site-control forwards only fixed routes using the control account", async () => {
  const calls = [];
  const handler = createSiteControlHandler({ cfg, security, controlKey,
    controlUsername: "control", controlAppPassword: "app-password",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ settings: {} }), { headers: { "content-type": "application/json" } });
    } });
  const res = response();
  await handler(request("GET", "/v1/site-control/site", controlKey), res);
  assert.equal(res.statusCode, 200);
  assert.equal(String(calls[0].url), "https://example.test/wp-json/wpbridge-control/v1/site");
  assert.equal(calls[0].options.headers.authorization,
    `Basic ${Buffer.from("control:app-password").toString("base64")}`);
  const res2 = response();
  await handler(request("GET", "/v1/site-control/site?url=https://evil.test", controlKey), res2);
  assert.equal(res2.statusCode, 404);
  assert.equal(calls.length, 1);
});
