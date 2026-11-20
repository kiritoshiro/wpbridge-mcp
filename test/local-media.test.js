import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../mcp/server.js";
import { createGateway } from "../mcp/gateway.js";
import { MAX_LOCAL_MEDIA_BYTES, readLocalMedia, resolveUploadDir } from "../mcp/local-media.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

function fixture() {
  const temp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "wpbridge-upload-")));
  const uploads = path.join(temp, "uploads");
  const outside = path.join(temp, "outside");
  fs.mkdirSync(path.join(uploads, "sub"), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(uploads, "photo.png"), png);
  fs.writeFileSync(path.join(uploads, "sub", "nested.png"), png);
  fs.writeFileSync(path.join(outside, "secret.png"), png);
  return { temp, uploads: resolveUploadDir(uploads), outside, cleanup: () => fs.rmSync(temp, { recursive: true, force: true }) };
}

test("upload directory setting must be an existing absolute local directory", () => {
  const { temp, uploads, cleanup } = fixture();
  try {
    assert.equal(resolveUploadDir(undefined), null);
    assert.equal(resolveUploadDir(""), null);
    assert.equal(resolveUploadDir(uploads), uploads);
    assert.throws(() => resolveUploadDir("relative/uploads"), /absolute/);
    assert.throws(() => resolveUploadDir("\\\\server\\share\\uploads"), /absolute local/);
    assert.throws(() => resolveUploadDir("//server/share/uploads"), /absolute local/);
    assert.throws(() => resolveUploadDir(path.join(temp, "missing")), /does not exist/);
    assert.throws(() => resolveUploadDir(path.join(uploads, "photo.png")), /local directory/);
    assert.throws(() => resolveUploadDir(path.parse(temp).root), /filesystem root/);
  } finally {
    cleanup();
  }
});

test("local media reads only regular supported files inside the upload directory", (t) => {
  const { uploads, outside, cleanup } = fixture();
  try {
    const media = readLocalMedia(uploads, "photo.png");
    assert.deepEqual(media, { filename: "photo.png", mimeType: "image/png", data: png });
    assert.equal(readLocalMedia(uploads, "sub/nested.png").filename, "nested.png");
    assert.equal(readLocalMedia(uploads, path.join(uploads, "photo.png")).filename, "photo.png");

    const refusals = [
      ["../outside/secret.png", /\.\./],
      ["sub/../../outside/secret.png", /\.\./],
      ["sub\\..\\..\\outside\\secret.png", /\.\./],
      [path.join(outside, "secret.png"), /inside the configured upload directory/],
      ["\\\\server\\share\\photo.png", /UNC and device/],
      ["//server/share/photo.png", /UNC and device/],
      ["\\\\?\\C:\\uploads\\photo.png", /UNC and device/],
      ["\\\\.\\C:\\uploads\\photo.png", /UNC and device/],
      ["\\??\\C:\\uploads\\photo.png", /UNC and device/],
      ["CON", /device names/],
      ["sub/nul.png", /device names/],
      ["photo.png:hidden", /data streams/],
      ["photo.png\u0000.txt", /non-empty path/],
      ["", /non-empty path/],
      ["missing.png", /does not exist/],
    ];
    for (const [requested, message] of refusals) {
      assert.throws(() => readLocalMedia(uploads, requested), message, requested);
    }

    fs.writeFileSync(path.join(uploads, "notes.txt"), "text");
    assert.throws(() => readLocalMedia(uploads, "notes.txt"), /Unsupported file extension/);
    fs.mkdirSync(path.join(uploads, "folder.png"));
    assert.throws(() => readLocalMedia(uploads, "folder.png"), /regular files/);
    fs.writeFileSync(path.join(uploads, "empty.png"), "");
    assert.throws(() => readLocalMedia(uploads, "empty.png"), /empty/);
    fs.writeFileSync(path.join(uploads, "big.png"), png);
    assert.throws(() => readLocalMedia(uploads, "big.png", { maxBytes: png.length - 1 }), /media limit/);
    // A sparse file larger than the bridge ceiling is refused from its size alone.
    const huge = path.join(uploads, "huge.pdf");
    fs.closeSync(fs.openSync(huge, "w"));
    fs.truncateSync(huge, MAX_LOCAL_MEDIA_BYTES + 1);
    assert.throws(() => readLocalMedia(uploads, "huge.pdf"), /media limit/);

    // Directory junctions (Windows) and directory symlinks may not point out.
    fs.symlinkSync(outside, path.join(uploads, "linked"), "junction");
    assert.throws(() => readLocalMedia(uploads, "linked/secret.png"), /resolves outside/);
    try {
      fs.symlinkSync(path.join(outside, "secret.png"), path.join(uploads, "escape.png"), "file");
    } catch (error) {
      if (error.code !== "EPERM") throw error;
      t.diagnostic("File symlinks need extra privileges here; the junction case covers link escapes.");
      return;
    }
    assert.throws(() => readLocalMedia(uploads, "escape.png"), /resolves outside/);
  } finally {
    cleanup();
  }
});

async function connected(options) {
  const calls = [];
  const gateway = createGateway([{ id: "alpha", bridgeUrl: "http://127.0.0.1:8787", key: "a".repeat(64),
    permissions: new Set(["read", "editorial"]), allowedActions: null }], { fetchImpl: async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ id: 7 }), { status: 201, headers: { "content-type": "application/json" } });
  } });
  const server = buildMcpServer(gateway, options);
  const client = new Client({ name: "wpbridge-local-media-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, calls, close: async () => { await client.close(); await server.close(); } };
}

test("upload_local_media is absent unless an upload directory is configured", async () => {
  const session = await connected({});
  try {
    const names = (await session.client.listTools()).tools.map((tool) => tool.name);
    assert.ok(!names.includes("upload_local_media"));
    assert.ok(names.includes("upload_attached_media"));
  } finally {
    await session.close();
  }
});

test("upload_local_media requires an idempotency key and refuses before contacting the bridge", async () => {
  const { uploads, cleanup } = fixture();
  const session = await connected({ localUploadDir: uploads, chatGptFiles: false });
  try {
    const names = (await session.client.listTools()).tools.map((tool) => tool.name);
    assert.ok(names.includes("upload_local_media"));
    assert.ok(!names.includes("upload_attached_media"));
    for (const args of [
      { site_id: "alpha", file: "photo.png" },
      { site_id: "alpha", file: "photo.png", idempotency_key: "short" },
      { site_id: "alpha", file: "photo.png", idempotency_key: "has spaces in it" },
    ]) {
      const result = await session.client.callTool({ name: "upload_local_media", arguments: args });
      assert.equal(result.isError, true);
    }
    const escaped = await session.client.callTool({ name: "upload_local_media",
      arguments: { site_id: "alpha", file: "../outside.png", idempotency_key: "upload-0001" } });
    assert.equal(escaped.isError, true);
    assert.match(escaped.content[0].text, /\.\./);
    assert.equal(session.calls.length, 0);
  } finally {
    await session.close();
    cleanup();
  }
});
