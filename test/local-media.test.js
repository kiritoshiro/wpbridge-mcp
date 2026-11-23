import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "../mcp/server.js";
import { createGateway } from "../mcp/gateway.js";
import { containedIn, MAX_LOCAL_MEDIA_BYTES, readLocalMedia, resolveUploadDir } from "../mcp/local-media.js";

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

    const refusals = [
      ["../outside/secret.png", /\.\./],
      ["sub/../../outside/secret.png", /\.\./],
      ["sub\\..\\..\\outside\\secret.png", /\.\./],
      [path.join(outside, "secret.png"), /relative to the configured upload directory/],
      [path.join(uploads, "photo.png"), /relative to the configured upload directory/],
      ["/photo.png", /relative to the configured upload directory/],
      ["\\photo.png", /relative to the configured upload directory/],
      ["C:/photo.png", /relative to the configured upload directory/],
      ["C:photo.png", /drive letters/],
      [".", /inside the configured upload directory/],
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

test("containment compares canonical paths with exact case", () => {
  // Pure string logic: runs the same on every platform.
  assert.equal(containedIn("C:\\vault\\Upload", "C:\\vault\\Upload\\secret.png", "\\"), true);
  assert.equal(containedIn("C:\\vault\\Upload", "C:\\vault\\Upload\\sub\\secret.png", "\\"), true);
  assert.equal(containedIn("C:\\vault\\Upload", "C:\\vault\\upload\\secret.png", "\\"), false);
  assert.equal(containedIn("C:\\vault\\Upload", "c:\\vault\\Upload\\secret.png", "\\"), false);
  assert.equal(containedIn("C:\\vault\\Upload", "C:\\vault\\Uploads\\secret.png", "\\"), false);
  assert.equal(containedIn("C:\\vault\\Upload", "C:\\vault\\Upload", "\\"), false);
  assert.equal(containedIn("C:\\vault\\Upload", "C:\\vault\\Upload\\", "\\"), false);
  assert.equal(containedIn("C:\\vault\\Upload", "C:\\vault", "\\"), false);
  assert.equal(containedIn("/srv/Upload", "/srv/Upload/a.png", "/"), true);
  assert.equal(containedIn("/srv/Upload", "/srv/upload/a.png", "/"), false);
  assert.equal(containedIn("/srv/Upload", "/srv/Upload2/a.png", "/"), false);
  assert.equal(containedIn("/srv/Upload", undefined, "/"), false);
});

// Creates a directory whose entries are case-sensitive, or explains why not.
function caseSensitiveDir(parent) {
  const dir = path.join(parent, "vault");
  fs.mkdirSync(dir);
  if (process.platform === "win32") {
    const result = spawnSync("fsutil.exe", ["file", "setCaseSensitiveInfo", dir, "enable"], { encoding: "utf8" });
    if (result.error || result.status !== 0) {
      const detail = (result.error?.message || result.stdout || result.stderr || "").trim();
      return { dir: null, reason: `fsutil could not enable case sensitivity (${detail})` };
    }
  }
  fs.mkdirSync(path.join(dir, "Upload"));
  try {
    fs.mkdirSync(path.join(dir, "upload"));
  } catch (error) {
    if (error.code === "EEXIST") return { dir: null, reason: "this file system is case-insensitive" };
    throw error;
  }
  return { dir };
}

test("a case-sensitive sibling directory is outside the upload directory", (t) => {
  const { temp, cleanup } = fixture();
  try {
    const { dir, reason } = caseSensitiveDir(temp);
    if (!dir) {
      t.diagnostic(`Skipped the case-sensitive directory subcase: ${reason}. The pure containment test covers the comparison.`);
      return;
    }
    fs.writeFileSync(path.join(dir, "Upload", "photo.png"), png);
    fs.writeFileSync(path.join(dir, "upload", "secret.png"), png);
    const uploads = resolveUploadDir(path.join(dir, "Upload"));
    assert.equal(readLocalMedia(uploads, "photo.png").filename, "photo.png");
    assert.throws(() => readLocalMedia(uploads, path.join(dir, "upload", "secret.png")), /relative to the configured upload directory/);
    // A link inside Upload that resolves into the sibling upload directory must
    // fail the exact-case canonical check (lowercased paths would pass it).
    fs.symlinkSync(path.join(dir, "upload"), path.join(dir, "Upload", "linked"), "junction");
    assert.throws(() => readLocalMedia(uploads, "linked/secret.png"), /resolves outside/);
  } finally {
    cleanup();
  }
});

test("hard links are refused", (t) => {
  const { uploads, outside, cleanup } = fixture();
  try {
    try {
      fs.linkSync(path.join(outside, "secret.png"), path.join(uploads, "hard.png"));
    } catch (error) {
      t.diagnostic(`Skipped: this file system cannot create hard links (${error.code}).`);
      return;
    }
    assert.throws(() => readLocalMedia(uploads, "hard.png"), /hard links/);
    // Both names of an inside file are refused once it gains a second link.
    assert.equal(readLocalMedia(uploads, "photo.png").filename, "photo.png");
    fs.linkSync(path.join(uploads, "photo.png"), path.join(uploads, "photo-copy.png"));
    assert.throws(() => readLocalMedia(uploads, "photo.png"), /hard links/);
    assert.throws(() => readLocalMedia(uploads, "photo-copy.png"), /hard links/);
  } finally {
    cleanup();
  }
});

test("a FIFO in the upload directory is refused without blocking", (t) => {
  if (process.platform !== "linux") {
    t.diagnostic(`Skipped: the FIFO case is Linux-only (platform is ${process.platform}).`);
    return;
  }
  const { uploads, cleanup } = fixture();
  try {
    const made = spawnSync("mkfifo", [path.join(uploads, "hang.png")]);
    if (made.error || made.status !== 0) {
      t.diagnostic("Skipped: mkfifo is not available.");
      return;
    }
    // Run in a child so a blocking open cannot stall the test runner.
    const moduleUrl = new URL("../mcp/local-media.js", import.meta.url).href;
    const script = `import { readLocalMedia } from ${JSON.stringify(moduleUrl)};
try { readLocalMedia(process.argv[1], "hang.png"); console.log("read"); }
catch (error) { console.log(error.message); }`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, uploads],
      { encoding: "utf8", timeout: 10_000 });
    assert.equal(result.signal, null, "reading a FIFO must not block");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /regular files/);
  } finally {
    cleanup();
  }
});

test("upload_local_media runs one upload at a time", async () => {
  const { uploads, cleanup } = fixture();
  fs.writeFileSync(path.join(uploads, "second.png"), png);
  let active = 0;
  let peak = 0;
  const started = [];
  const releases = [];
  const gateway = createGateway([{ id: "alpha", bridgeUrl: "http://127.0.0.1:8787", key: "a".repeat(64),
    permissions: new Set(["read", "editorial"]), allowedActions: null }], { fetchImpl: async (url, init) => {
    active += 1;
    peak = Math.max(peak, active);
    started.push(JSON.parse(init.body).body.filename);
    await new Promise((resolve) => releases.push(resolve));
    active -= 1;
    return new Response(JSON.stringify({ id: 7 }), { status: 201, headers: { "content-type": "application/json" } });
  } });
  const server = buildMcpServer(gateway, { localUploadDir: uploads, chatGptFiles: false });
  const client = new Client({ name: "wpbridge-local-media-serial-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
  try {
    const first = client.callTool({ name: "upload_local_media",
      arguments: { site_id: "alpha", file: "photo.png", idempotency_key: "serial-0001" } });
    const second = client.callTool({ name: "upload_local_media",
      arguments: { site_id: "alpha", file: "second.png", idempotency_key: "serial-0002" } });
    while (started.length < 1) await settle();
    await settle();
    assert.deepEqual(started, ["photo.png"], "the second upload waits while the first is in flight");
    releases.shift()();
    assert.equal((await first).isError, false);
    while (started.length < 2) await settle();
    assert.deepEqual(started, ["photo.png", "second.png"]);
    releases.shift()();
    assert.equal((await second).isError, false);
    assert.equal(peak, 1);
  } finally {
    for (const release of releases) release();
    await client.close();
    await server.close();
    cleanup();
  }
});
