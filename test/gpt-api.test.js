import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { buildGptSchema, groups, operations, translateGptRequest } from "../lib/gpt-api.js";

function request(group, input) {
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(input))]), {
    url: `/gpt/${group}`, method: "POST", headers: { authorization: "Bearer test" }, socket: {},
  });
}

function addMissingObjectProperties(value) {
  if (Array.isArray(value)) return value.map(addMissingObjectProperties);
  if (!value || typeof value !== "object") return value;
  const copy = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, addMissingObjectProperties(child)]));
  if (copy.type === "object" && !Object.hasOwn(copy, "properties")) copy.properties = {};
  return copy;
}

function assertObjectSchemasHaveProperties(value, context = "schema") {
  if (!value || typeof value !== "object") return;
  if (value.type === "object") assert.ok(value.properties && typeof value.properties === "object", `${context} is missing properties`);
  for (const [key, child] of Object.entries(value)) assertObjectSchemasHaveProperties(child, `${context}.${key}`);
}

test("GPT schema has grouped operations plus direct conversation-file upload", () => {
  const schema = buildGptSchema("https://example.test");
  assert.equal(Object.keys(schema.paths).length, 14);
  assert.equal(operations.size, 100);
  assert.ok(schema.components.schemas.CalendarEvent);
  for (const [route, item] of Object.entries(schema.paths)) {
    for (const [method, operation] of Object.entries(item)) {
      assert.ok(
        !operation.description || operation.description.length <= 300,
        `${method.toUpperCase()} ${route} description exceeds 300 characters`
      );
    }
  }
  const actions = [];
  for (const [group, ids] of Object.entries(groups)) {
    const op = schema.paths[`/gpt/${group}`].post;
    const requestSchema = op.requestBody.content["application/json"].schema;
    assert.equal(requestSchema.type, "object");
    assert.ok(requestSchema.properties && typeof requestSchema.properties === "object");
    assert.deepEqual(requestSchema.properties.action.enum, ids);
    assert.deepEqual(requestSchema.required, ["action"]);
    assertObjectSchemasHaveProperties(requestSchema, group);
    assert.ok(Array.isArray(requestSchema.oneOf));
    assert.equal(op["x-openai-isConsequential"], ids.some((id) => operations.get(id).method !== "GET"));
    for (const variant of requestSchema.oneOf) {
      const id = variant.properties.action.enum[0];
      actions.push(id);
      assert.deepEqual(variant.properties.body, addMissingObjectProperties(operations.get(id).spec.requestBody?.content?.["application/json"]?.schema));
    }
  }
  const groupedIds = [...operations].filter(([, operation]) => !operation.spec["x-gpt-direct"]).map(([id]) => id);
  assert.deepEqual(actions.sort(), groupedIds.sort());
  const direct = schema.paths["/gpt/uploadConversationImages"].post;
  assert.equal(direct.operationId, "uploadConversationImages");
  const fileRef = direct.requestBody.content["application/json"].schema.properties.openaiFileIdRefs.items;
  assert.equal(fileRef.type, "object");
  assert.deepEqual(fileRef.required, ["id", "name", "mime_type", "download_link"]);
  assert.equal(fileRef.properties.mime_type.enum.includes("audio/mpeg"), true);
  assert.equal(fileRef.properties.mime_type.enum.includes("application/pdf"), true);
  assertObjectSchemasHaveProperties(direct.requestBody.content["application/json"].schema, "uploadConversationImages");
  const mediaResponse = schema.paths["/gpt/media"].post.responses["200"].content["application/json"].schema;
  assert.ok(mediaResponse.properties.openaiFileResponse);
  assert.equal(mediaResponse.properties.openaiFileResponse.type, "array");
});

test("direct conversation-file action maps only to the fixed attachment upload route", async () => {
  const original = request("uploadConversationImages", { openaiFileIdRefs: [], idempotency_key: "image-upload-1" });
  original.url = "/gpt/uploadConversationImages";
  const mapped = await translateGptRequest(original, 100000);
  assert.equal(mapped.method, "POST");
  assert.equal(mapped.url, "/v1/media/from-chatgpt");
  const chunks = [];
  for await (const chunk of mapped) chunks.push(chunk);
  assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString("utf8")), {
    openaiFileIdRefs: [], idempotency_key: "image-upload-1",
  });
});

test("grouped list actions serialize typed array filters without widening the dispatcher", async () => {
  const original = request("contentRead", {
    action: "listPosts",
    query: {
      category_ids: [4, 8],
      tag_exclude_ids: [3],
      sticky: false,
      orderby: "title",
      order: "asc",
    },
  });
  const mapped = await translateGptRequest(original, 100000);
  const mappedUrl = new URL(mapped.url, "http://bridge.test");
  assert.equal(mappedUrl.pathname, "/v1/posts");
  assert.equal(mappedUrl.searchParams.get("category_ids"), "4,8");
  assert.equal(mappedUrl.searchParams.get("tag_exclude_ids"), "3");
  assert.equal(mappedUrl.searchParams.get("sticky"), "false");
  assert.equal(mappedUrl.searchParams.get("orderby"), "title");
  assert.equal(mappedUrl.searchParams.get("order"), "asc");

  await assert.rejects(
    () => translateGptRequest(request("contentRead", {
      action: "listPosts",
      query: { category_ids: ["4"] },
    }), 100000),
    { status: 400 }
  );
});

test("every allowlisted action translates to its original method and route", async () => {
  for (const [group, ids] of Object.entries(groups)) {
    for (const action of ids) {
      const op = operations.get(action);
      const path = Object.fromEntries((op.spec.parameters || []).filter((p) => p.in === "path").map((p) => [p.name, "1"]));
      const query = Object.fromEntries((op.spec.parameters || []).filter((p) => p.in === "query" && p.required).map((p) => [p.name, "1"]));
      const input = { action, path, query, ...(op.spec.requestBody ? { body: {} } : {}) };
      const original = request(group, input);
      const mapped = await translateGptRequest(original, 100000);
      assert.equal(mapped.method, op.method);
      assert.equal(mapped.url.split("?")[0], op.path.replace(/\{[^}]+\}/g, "1"));
      assert.equal(mapped.headers, original.headers);
      assert.equal(original.bridgeTarget.method, op.method);
    }
  }
});

test("group dispatcher rejects arbitrary targets, wrong groups, traversal, and oversized envelopes", async () => {
  for (const [group, input] of [
    ["unknown", { action: "getPost" }],
    ["contentRead", { action: "publishPost" }],
    ["contentRead", { action: "getPost", path: { id: "../users" } }],
    ["contentRead", { action: "getPost", path: { id: "1?x=2" } }],
    ["contentRead", { action: "getPost", path: { id: "1" }, url: "https://evil.test" }],
    ["contentRead", { action: "getPost", path: { id: "1" }, query: { proxy: "yes" } }],
    ["contentRead", { action: "getPost" }],
  ]) await assert.rejects(() => translateGptRequest(request(group, input), 100000), { status: 400 });
  await assert.rejects(() => translateGptRequest(request("contentRead", { action: "listPosts" }), 1), { status: 413 });
});
