import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const key = "a".repeat(64);
const token = "m".repeat(64);

function registry(dir, bridgePort) {
  const file = path.join(dir, "sites.json");
  fs.writeFileSync(file, JSON.stringify({ sites: [{
    id: "alpha", bridge_url: `http://127.0.0.1:${bridgePort}`,
    bridge_key_env: "SITE_KEY", permissions: ["read"], allowed_actions: ["listPosts"],
  }] }));
  return file;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function ready(child) {
  await new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error("MCP HTTP server did not start.")), 5000);
    child.stderr.on("data", (chunk) => {
      output += chunk;
      if (output.includes("WPBridge MCP listening")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`MCP HTTP server exited ${code}: ${output}`));
    });
  });
}

test("installed local plugin launcher connects to the stdio MCP server", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wpbridge-local-"));
  const plugin = path.join(temp, "plugin");
  fs.mkdirSync(plugin);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "plugins", "wpbridge", ".mcp.json"), "utf8"));
  const config = manifest.mcpServers.wpbridge;
  fs.copyFileSync(path.join(root, "plugins", "wpbridge", "launcher.mjs"), path.join(plugin, "launcher.mjs"));
  const localConfig = path.join(temp, "local.json");
  const configured = spawnSync(process.execPath, [path.join(root, "scripts", "configure-local-plugin.mjs")], {
    cwd: root, env: { ...process.env, WPBRIDGE_MCP_LOCAL_CONFIG: localConfig }, encoding: "utf8",
  });
  assert.equal(configured.status, 0, configured.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(localConfig, "utf8")), { repo_root: root });
  const sitesFile = registry(temp, 1);
  const client = new Client({ name: "wpbridge-stdio-test", version: "1.0.0" });
  try {
    const transport = new StdioClientTransport({
      command: process.execPath, args: config.args, cwd: plugin,
      env: { ...process.env, WPBRIDGE_MCP_LOCAL_CONFIG: localConfig, WPBRIDGE_MCP_SITES_FILE: sitesFile, SITE_KEY: key },
      stderr: "pipe",
    });
    await client.connect(transport);
    const sites = await client.callTool({ name: "list_sites", arguments: {} });
    assert.deepEqual(JSON.parse(sites.content[0].text), [{ id: "alpha", permissions: ["read"] }]);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "wpbridge_contentRead"));
  } finally {
    await client.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("loopback HTTP MCP requires a token and routes a real client request", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wpbridge-http-"));
  const calls = [];
  const bridge = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push({ path: req.url, authorization: req.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ posts: [] }));
  });
  await new Promise((resolve) => bridge.listen(0, "127.0.0.1", resolve));
  const sitesFile = registry(temp, bridge.address().port);
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(root, "mcp", "server.js"), "--http"], {
    cwd: root,
    env: { ...process.env, WPBRIDGE_MCP_SITES_FILE: sitesFile, SITE_KEY: key,
      WPBRIDGE_MCP_TOKEN: token, WPBRIDGE_MCP_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const client = new Client({ name: "wpbridge-http-test", version: "1.0.0" });
  try {
    await ready(child);
    const url = `http://127.0.0.1:${port}/mcp`;
    const unauthorized = await fetch(url, { method: "POST", body: "{}" });
    assert.equal(unauthorized.status, 401);
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);
    const sites = await client.callTool({ name: "list_sites", arguments: {} });
    assert.deepEqual(JSON.parse(sites.content[0].text), [{ id: "alpha", permissions: ["read"] }]);
    const posts = await client.callTool({
      name: "wpbridge_contentRead", arguments: { site_id: "alpha", action: "listPosts" },
    });
    assert.equal(posts.structuredContent.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, "/gpt/contentRead");
    assert.equal(calls[0].authorization, `Bearer ${key}`);
    assert.deepEqual(calls[0].body, { action: "listPosts" });
  } finally {
    await client.close();
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
    await new Promise((resolve) => bridge.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
