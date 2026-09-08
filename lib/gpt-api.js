import fs from "node:fs";
import { Readable } from "node:stream";
import { parse } from "yaml";
import { readJson } from "./http.js";

// Only these named capabilities can be dispatched. No caller-supplied URL/method.
export const groups = {
  contentRead: ["bridgeHealth", "listPosts", "getPost", "listPages", "getPage", "listPostBlocks", "listPageBlocks"],
  contentCreate: ["createDraft", "createPageDraft"],
  contentPreview: ["previewPostEdit", "previewPageEdit"],
  contentEdit: ["updatePost", "updatePage", "editPostBlock", "editPageBlock"],
  contentVisibility: ["publishPost", "schedulePost", "unpublishPost", "submitPostForReview", "publishPage", "schedulePage", "unpublishPage", "submitPageForReview"],
  media: ["listMedia", "getMedia", "uploadMedia", "updateMedia"],
  taxonomy: ["listCategories", "createCategory", "listTags", "createTag", "listCustomTaxonomies", "listCustomTaxonomyTerms", "createCustomTaxonomyTerm", "getCustomItemTaxonomies", "assignCustomTaxonomyTerms", "removeCustomTaxonomyTerms"],
  seo: ["getSeoCapabilities", "getPostSeo", "updatePostSeo", "getPageSeo", "updatePageSeo"],
  comments: ["listComments", "getComment", "approveComment", "unapproveComment", "replyToComment"],
  recovery: ["listActivity", "getActivity", "restoreActivityPreview", "restoreActivity", "listPostRevisions", "getPostRevision", "restorePostRevision", "listPageRevisions", "getPageRevision", "restorePageRevision", "listCustomItemRevisions", "getCustomItemRevision", "restoreCustomItemRevision"],
  editorial: ["getEditorialStatus", "auditEditorialContent", "getEditorialQueue", "getSiteDiscovery", "listAuthors", "getAuthor", "bulkEditEditorialMetadata"],
  customContent: ["listCustomPostTypes", "listCustomItems", "createCustomDraft", "getCustomItem", "updateCustomItem", "previewCustomItemEdit", "publishCustomItem", "unpublishCustomItem", "scheduleCustomItem", "submitCustomItemForReview", "listCustomItemBlocks", "editCustomItemBlock", "getCustomFields", "updateCustomFields"],
};

export const fullSchema = parse(fs.readFileSync(new URL("../openapi.template.yaml", import.meta.url), "utf8"));
export const operations = new Map();
for (const [path, item] of Object.entries(fullSchema.paths)) {
  for (const [method, spec] of Object.entries(item)) {
    if (!spec.operationId) continue;
    if (operations.has(spec.operationId)) throw new Error("Duplicate operation ID");
    operations.set(spec.operationId, { path, method: method.toUpperCase(), spec });
  }
}
const selected = Object.values(groups).flat();
const groupedOperationIds = [...operations].filter(([, operation]) => !operation.spec["x-gpt-direct"]).map(([id]) => id);
if (new Set(selected).size !== selected.length || selected.length !== groupedOperationIds.length || selected.some((id) => !groupedOperationIds.includes(id))) {
  throw new Error("GPT group allowlist must cover every original operation exactly once.");
}

function parameterSchema(parameters) {
  return {
    type: "object", additionalProperties: false,
    properties: Object.fromEntries(parameters.map((p) => [p.name, { ...p.schema, ...(p.description ? { description: p.description } : {}) }])),
    required: parameters.filter((p) => p.required).map((p) => p.name),
  };
}

function importerCompatibleSchema(value) {
  if (Array.isArray(value)) return value.map(importerCompatibleSchema);
  if (!value || typeof value !== "object") return value;
  const copy = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, importerCompatibleSchema(child)]));
  if (copy.type === "object" && !Object.hasOwn(copy, "properties")) copy.properties = {};
  return copy;
}

function importerProperties(ids, variants) {
  const properties = {
    action: {
      type: "string",
      enum: ids,
      description: "Select the restricted action to run. Supply only the matching path, query, and body fields described by its typed variant.",
    },
  };
  for (const location of ["path", "query", "body"]) {
    const schemas = variants.map((variant) => variant.properties[location]).filter(Boolean);
    if (!schemas.length) continue;
    properties[location] = {
      type: "object",
      description: `${location} fields for the selected action; omit when that action does not use them.`,
      properties: Object.assign({}, ...schemas.map((schema) => schema.properties || {})),
    };
  }
  return properties;
}

export function buildGptSchema(base = "__PUBLIC_BASE_URL__") {
  const paths = {};
  for (const [group, ids] of Object.entries(groups)) {
    const variants = ids.map((id) => {
      const { spec } = operations.get(id);
      const properties = { action: { type: "string", enum: [id], description: spec.summary } };
      const required = ["action"];
      for (const location of ["path", "query"]) {
        const parameters = (spec.parameters || []).filter((p) => p.in === location);
        if (parameters.length) {
          properties[location] = parameterSchema(parameters);
          if (parameters.some((p) => p.required)) required.push(location);
        }
      }
      const body = importerCompatibleSchema(spec.requestBody?.content?.["application/json"]?.schema);
      if (body) {
        properties.body = body;
        if (spec.requestBody.required) required.push("body");
      }
      return { type: "object", additionalProperties: false, description: [spec.summary, spec.description].filter(Boolean).join(" "), properties, required };
    });
    paths[`/gpt/${group}`] = { post: {
      operationId: group,
      summary: `Restricted ${group} operations`,
      description: "Select action and its matching typed input. Original permissions, confirmations, version checks and idempotency requirements apply. Responses use the selected action's original response format.",
      "x-openai-isConsequential": ids.some((id) => operations.get(id).method !== "GET"),
      requestBody: { required: true, content: { "application/json": { schema: {
        type: "object",
        additionalProperties: false,
        properties: importerProperties(ids, variants),
        required: ["action"],
        oneOf: variants,
      } } } },
      responses: { "200": { description: "Selected operation result; creates may return 201, partial results 206. Original error status and body are preserved." }, "400": { description: "Invalid action or input" }, "401": { description: "Authentication required" }, "403": { description: "Action forbidden" }, "409": { description: "Conflict or confirmation required" } },
    } };
  }
  const directUpload = operations.get("uploadConversationImages");
  if (!directUpload?.spec?.["x-gpt-direct"]) throw new Error("Missing direct GPT conversation-image upload operation.");
  const { ["x-gpt-direct"]: _directMarker, ...directUploadSpec } = directUpload.spec;
  paths["/gpt/uploadConversationImages"] = { post: importerCompatibleSchema(directUploadSpec) };
  return {
    openapi: "3.1.0",
    info: { title: "WPBridge GPT API", version: fullSchema.info.version, description: "All restricted editorial capabilities through 12 grouped operations plus a conversation-file image uploader." },
    servers: [{ url: base }],
    security: fullSchema.security,
    components: { ...fullSchema.components, schemas: fullSchema.components?.schemas || {} },
    paths,
  };
}

function invalid(message) {
  return Object.assign(new Error(message), { status: 400, code: "invalid_gpt_request" });
}
function object(value) { return value && typeof value === "object" && !Array.isArray(value); }

export async function translateGptRequest(req, maxBodyBytes) {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "POST" && url.pathname === "/gpt/uploadConversationImages" && !url.search) {
    const input = await readJson(req, maxBodyBytes);
    req.bridgeTarget = { method: "POST", path: "/v1/media/from-chatgpt" };
    const translated = Readable.from([Buffer.from(JSON.stringify(input))]);
    translated.method = "POST";
    translated.url = "/v1/media/from-chatgpt";
    translated.headers = req.headers;
    translated.socket = req.socket;
    return translated;
  }
  const group = url.pathname.slice("/gpt/".length);
  if (req.method !== "POST" || !Object.hasOwn(groups, group) || url.search) throw invalid("Unknown GPT group, method, or query string.");
  const input = await readJson(req, maxBodyBytes);
  if (Object.keys(input).some((key) => !["action", "path", "query", "body"].includes(key))) throw invalid("Unexpected envelope field.");
  if (!groups[group].includes(input.action)) throw invalid("Action is not allowed in this group.");
  const operation = operations.get(input.action);
  let target = operation.path;
  const query = new URLSearchParams();
  for (const location of ["path", "query"]) {
    const values = input[location] ?? {};
    if (!object(values)) throw invalid(`${location} must be an object.`);
    const allowed = (operation.spec.parameters || []).filter((p) => p.in === location);
    if (Object.keys(values).some((key) => !allowed.some((p) => p.name === key))) throw invalid(`Unexpected ${location} parameter.`);
    for (const p of allowed) {
      const value = values[p.name];
      if (value === undefined) { if (p.required) throw invalid(`Missing ${location}.${p.name}`); continue; }
      if (!["string", "number", "boolean"].includes(typeof value)) throw invalid(`Invalid ${location}.${p.name}`);
      if (location === "path") {
        if (!/^[A-Za-z0-9_-]+$/.test(String(value))) throw invalid("Unsafe path parameter.");
        target = target.replace(`{${p.name}}`, encodeURIComponent(value));
      } else query.set(p.name, String(value));
    }
  }
  if (input.body !== undefined && (!object(input.body) || !operation.spec.requestBody)) throw invalid("Unexpected or invalid body.");
  if (operation.spec.requestBody?.required && input.body === undefined) throw invalid("Missing body.");
  if (query.size) target += `?${query}`;
  req.bridgeTarget = { method: operation.method, path: target.split("?")[0] };
  const translated = Readable.from([Buffer.from(JSON.stringify(input.body || {}))]);
  translated.method = operation.method;
  translated.url = target;
  translated.headers = req.headers;
  translated.socket = req.socket;
  return translated;
}
