import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../mcp/server.js";
import { createGateway, loadSites, permissionFor } from "../mcp/gateway.js";

const keyA = "a".repeat(64);
const keyB = "b".repeat(64);
const controlKey = "c".repeat(64);

function sampleSites() {
  return [
    { id: "alpha", bridgeUrl: "http://127.0.0.1:8787", key: keyA, controlKey,
      permissions: new Set(["read", "editorial", "site_read"]), allowedActions: null },
    { id: "beta", bridgeUrl: "http://127.0.0.1:8788", key: keyB,
      permissions: new Set(["read"]), allowedActions: new Set(["listPosts"]) },
  ];
}

test("site registry rejects external targets and missing credentials", () => {
  const file = path.join(os.tmpdir(), `wpbridge-mcp-${crypto.randomUUID()}.json`);
  try {
    fs.writeFileSync(file, JSON.stringify({ sites: [{
      id: "alpha", bridge_url: "https://example.com", bridge_key_env: "SITE_KEY", permissions: ["read"],
    }] }));
    assert.throws(() => loadSites(file, { SITE_KEY: keyA }), /loopback/);
    fs.writeFileSync(file, JSON.stringify({ sites: [{
      id: "alpha", bridge_url: "http://127.0.0.1:8787", bridge_key_env: "SITE_KEY", permissions: ["read"],
    }] }));
    assert.throws(() => loadSites(file, {}), /Missing bridge key/);
    assert.equal(loadSites(file, { SITE_KEY: keyA })[0].id, "alpha");
    fs.writeFileSync(file, JSON.stringify({ sites: [{
      id: "alpha", bridge_url: "http://127.0.0.1:8787", bridge_key_env: "SITE_KEY",
      control_key_env: "CONTROL_KEY", permissions: ["read", "site_read"],
    }] }));
    assert.throws(() => loadSites(file, { SITE_KEY: keyA, CONTROL_KEY: keyA }), /must differ/);
    assert.equal(loadSites(file, { SITE_KEY: keyA, CONTROL_KEY: "c".repeat(64) })[0].id, "alpha");
  } finally {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
});

test("gateway routes one site's guarded action using only its own key", async () => {
  const calls = [];
  const gateway = createGateway(sampleSites(), { fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ posts: [] }), { headers: { "content-type": "application/json" } });
  } });
  const result = await gateway.invoke({ site_id: "beta", action: "listPosts", query: { per_page: 3 } });
  assert.equal(result.ok, true);
  assert.equal(result.site_id, "beta");
  assert.equal(calls[0].url, "http://127.0.0.1:8788/gpt/contentRead");
  assert.equal(calls[0].options.headers.authorization, `Bearer ${keyB}`);
  assert.deepEqual(JSON.parse(calls[0].options.body), { action: "listPosts", query: { per_page: 3 } });
  assert.ok(!JSON.stringify(gateway.listSites()).includes(keyB));
  await assert.rejects(gateway.invoke({ site_id: "missing", action: "listPosts" }), /Unknown or unavailable/);
  await assert.rejects(gateway.invoke({ site_id: "beta", action: "updatePost" }), /disabled/);
  assert.equal(calls.length, 1);
});

test("publish and maintenance require separate site permissions", async () => {
  const gateway = createGateway(sampleSites(), { fetchImpl: async () => { throw new Error("must not fetch"); } });
  assert.equal(permissionFor("publishPost"), "publish");
  assert.equal(permissionFor("updatePlugin"), "plugin_updates");
  await assert.rejects(gateway.invoke({ site_id: "alpha", action: "publishPost" }), /disabled/);
  await assert.rejects(gateway.invoke({ site_id: "alpha", action: "updatePlugin" }), /disabled/);
});

test("site control uses fixed paths and rejects extra routing parameters", async () => {
  const calls = [];
  const gateway = createGateway(sampleSites(), { fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ settings: {}, fingerprint: "x" }), {
      headers: { "content-type": "application/json" },
    });
  } });
  await gateway.invoke({ site_id: "alpha", action: "getSite" });
  assert.equal(calls[0].url, "http://127.0.0.1:8787/v1/site-control/site");
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.headers.authorization, `Bearer ${controlKey}`);
  await assert.rejects(gateway.invoke({ site_id: "alpha", action: "getSite", path: { url: "evil" } }), /Unexpected/);
});

test("attached media is translated to the existing guarded GPT upload action", async () => {
  const sites = sampleSites();
  sites[0].allowedActions = new Set(["uploadAttachedMedia"]);
  let call;
  const gateway = createGateway(sites, { fetchImpl: async (url, options) => {
    call = { url, options };
    return new Response(JSON.stringify({ uploaded: true }), { headers: { "content-type": "application/json" } });
  } });
  await gateway.invoke({ site_id: "alpha", action: "uploadAttachedMedia", body: {
    files: [{ file_id: "file_1", file_name: "photo.png", mime_type: "image/png", download_url: "https://example.oaiusercontent.com/photo" }],
    idempotency_key: "one-upload",
  } });
  assert.equal(call.url, "http://127.0.0.1:8787/gpt/uploadConversationImages");
  assert.deepEqual(JSON.parse(call.options.body).openaiFileIdRefs, [{
    id: "file_1", name: "photo.png", mime_type: "image/png", download_link: "https://example.oaiusercontent.com/photo",
  }]);
});

test("MCP client discovers sites and invokes a grouped action", async () => {
  const gateway = createGateway(sampleSites(), { fetchImpl: async () =>
    new Response(JSON.stringify({ posts: [] }), { headers: { "content-type": "application/json" } }) });
  const server = buildMcpServer(gateway);
  const client = new Client({ name: "wpbridge-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    assert.ok(listed.tools.some((tool) => tool.name === "wpbridge_contentRead"));
    const sites = await client.callTool({ name: "list_sites", arguments: {} });
    assert.match(sites.content[0].text, /alpha/);
    const posts = await client.callTool({ name: "wpbridge_contentRead", arguments: { site_id: "beta", action: "listPosts" } });
    assert.equal(posts.structuredContent.ok, true);
  } finally {
    await client.close();
    await server.close();
  }
});
