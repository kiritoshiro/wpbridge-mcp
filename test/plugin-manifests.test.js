import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pluginRoot = path.join(root, "plugins", "wpbridge");
const read = (...parts) => JSON.parse(fs.readFileSync(path.join(...parts), "utf8"));
const key = "a".repeat(64);
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

function assertInside(base, relative, label) {
  assert.equal(typeof relative, "string", label);
  assert.ok(relative === "." || relative.startsWith("./"), `${label} must be a ./ relative path`);
  const resolved = path.resolve(base, relative);
  assert.ok(!path.relative(base, resolved).startsWith(".."), `${label} escapes ${base}`);
  assert.ok(fs.existsSync(resolved), `${label} does not exist: ${relative}`);
  return resolved;
}

test("Codex and Claude Code manifests and marketplaces reference existing plugin files", () => {
  const codex = read(pluginRoot, ".codex-plugin", "plugin.json");
  const claude = read(pluginRoot, ".claude-plugin", "plugin.json");
  const codexMarket = read(root, ".agents", "plugins", "marketplace.json");
  const claudeMarket = read(root, ".claude-plugin", "marketplace.json");

  assert.equal(codex.name, "wpbridge");
  assert.equal(claude.name, "wpbridge");
  assert.match(claude.version, /^\d+\.\d+\.\d+$/);
  assert.equal(codex.version.split("+")[0], claude.version, "plugin versions must match");
  const serverSource = fs.readFileSync(path.join(root, "mcp", "server.js"), "utf8");
  assert.ok(serverSource.includes(`{ name: "wpbridge", version: "${claude.version}" }`), "MCP server version must match");

  // Codex: skills directory and the .mcp.json launcher, resolved from cwd ".".
  assertInside(pluginRoot, codex.skills, "codex skills");
  const codexServers = read(assertInside(pluginRoot, codex.mcpServers, "codex mcpServers"));
  const codexServer = codexServers.mcpServers.wpbridge;
  assert.equal(codexServer.command, "node");
  const codexCwd = assertInside(pluginRoot, codexServer.cwd, "codex server cwd");
  assertInside(codexCwd, codexServer.args[0], "codex launcher");

  // Claude Code: its inline server replaces the same-named .mcp.json entry and
  // uses ${CLAUDE_PLUGIN_ROOT}, because Claude Code does not resolve a
  // relative launcher from the plugin directory.
  const claudeServer = claude.mcpServers.wpbridge;
  assert.equal(claudeServer.command, "node");
  assert.deepEqual(claudeServer.args, ["${CLAUDE_PLUGIN_ROOT}/launcher.mjs"]);
  assert.equal(claudeServer.cwd, undefined);
  assert.ok(fs.existsSync(path.join(pluginRoot, "launcher.mjs")));
  assert.ok(fs.existsSync(path.join(pluginRoot, "skills", "manage-wordpress", "SKILL.md")));

  const codexEntry = codexMarket.plugins.find((plugin) => plugin.name === "wpbridge");
  assert.equal(codexEntry.source.source, "local");
  assert.equal(assertInside(root, codexEntry.source.path, "codex marketplace source"), pluginRoot);
  assert.equal(typeof claudeMarket.name, "string");
  assert.equal(typeof claudeMarket.owner?.name, "string");
  const claudeEntry = claudeMarket.plugins.find((plugin) => plugin.name === "wpbridge");
  assert.equal(assertInside(root, claudeEntry.source, "claude marketplace source"), pluginRoot);
  assert.equal(claudeEntry.version, undefined, "plugin.json owns the version");

  const machinePath = /(?<![A-Za-z])[A-Za-z]:[\\/]|\/Users\/|\/home\//;
  for (const file of [
    path.join(pluginRoot, ".codex-plugin", "plugin.json"), path.join(pluginRoot, ".claude-plugin", "plugin.json"),
    path.join(pluginRoot, ".mcp.json"), path.join(pluginRoot, "launcher.mjs"),
    path.join(root, ".agents", "plugins", "marketplace.json"), path.join(root, ".claude-plugin", "marketplace.json"),
  ]) assert.doesNotMatch(fs.readFileSync(file, "utf8"), machinePath, file);
});

test("shared skill stays client-neutral", () => {
  const skill = fs.readFileSync(path.join(pluginRoot, "skills", "manage-wordpress", "SKILL.md"), "utf8");
  assert.match(skill, /^---\r?\nname: manage-wordpress\r?\ndescription: .+\r?\n---/);
  assert.doesNotMatch(skill, /chatgpt|openai|custom gpt|code interpreter|upload_attached_media|openaiFileIdRefs/i);
});

test("installed Claude Code server definition launches stdio MCP and uploads a local file", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wpbridge-claude-"));
  const installed = path.join(temp, "cache", "wpbridge");
  const session = path.join(temp, "project");
  const uploads = path.join(temp, "uploads");
  fs.cpSync(pluginRoot, installed, { recursive: true });
  fs.mkdirSync(session);
  fs.mkdirSync(uploads);
  fs.writeFileSync(path.join(uploads, "photo.png"), png);
  const localConfig = path.join(temp, "local.json");
  const configured = spawnSync(process.execPath, [path.join(root, "scripts", "configure-local-plugin.mjs")], {
    cwd: root, env: { ...process.env, WPBRIDGE_MCP_LOCAL_CONFIG: localConfig }, encoding: "utf8",
  });
  assert.equal(configured.status, 0, configured.stderr);

  const calls = [];
  const bridge = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push({ path: req.url, authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: 42, mime_type: "image/png" }));
  });
  await new Promise((resolve) => bridge.listen(0, "127.0.0.1", resolve));
  const sitesFile = path.join(temp, "sites.json");
  fs.writeFileSync(sitesFile, JSON.stringify({ sites: [{
    id: "alpha", bridge_url: `http://127.0.0.1:${bridge.address().port}`, bridge_key_env: "SITE_KEY",
    permissions: ["read", "editorial"], allowed_actions: ["listPosts", "uploadMedia"],
  }] }));

  const server = read(installed, ".claude-plugin", "plugin.json").mcpServers.wpbridge;
  const args = server.args.map((arg) => arg.replaceAll("${CLAUDE_PLUGIN_ROOT}", installed));
  const client = new Client({ name: "wpbridge-claude-test", version: "1.0.0" });
  try {
    await client.connect(new StdioClientTransport({
      command: process.execPath, args, cwd: session,
      env: { ...process.env, WPBRIDGE_MCP_LOCAL_CONFIG: localConfig, WPBRIDGE_MCP_SITES_FILE: sitesFile,
        SITE_KEY: key, WPBRIDGE_MCP_UPLOAD_DIR: uploads },
      stderr: "pipe",
    }));
    const sites = await client.callTool({ name: "list_sites", arguments: {} });
    assert.deepEqual(JSON.parse(sites.content[0].text), [{ id: "alpha", permissions: ["read", "editorial"] }]);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(names.includes("upload_local_media"));
    assert.ok(!names.includes("upload_attached_media"), "ChatGPT file uploads are not offered over stdio");

    const refused = await client.callTool({ name: "upload_local_media",
      arguments: { site_id: "alpha", file: "../local.json", idempotency_key: "upload-0001" } });
    assert.equal(refused.isError, true);
    assert.equal(calls.length, 0);

    const uploaded = await client.callTool({ name: "upload_local_media", arguments: {
      site_id: "alpha", file: "photo.png", idempotency_key: "upload-0002", alt_text: "One pixel",
    } });
    assert.equal(uploaded.isError, false);
    assert.equal(uploaded.structuredContent.status, 201);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, "/gpt/media");
    assert.equal(calls[0].authorization, `Bearer ${key}`);
    const { action, body } = calls[0].body;
    assert.equal(action, "uploadMedia");
    assert.deepEqual({ ...body, data_base64: undefined }, {
      filename: "photo.png", mime_type: "image/png", data_base64: undefined,
      idempotency_key: "upload-0002", alt_text: "One pixel",
    });
    assert.deepEqual(Buffer.from(body.data_base64, "base64"), png);
  } finally {
    await client.close();
    await new Promise((resolve) => bridge.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
