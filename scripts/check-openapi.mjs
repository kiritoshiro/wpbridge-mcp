import fs from "node:fs";
import assert from "node:assert/strict";
import { parse } from "yaml";
import { buildGptSchema } from "../lib/gpt-api.js";

function normalizePath(value) {
  return value
    .replace(/[.,;:]$/, "")
    .replace(/:[A-Za-z][A-Za-z0-9_]*/g, "{}")
    .replace(/\{[^}]+\}/g, "{}");
}

function expandHandlerPath(raw) {
  const cleaned = raw.replace(/[.,;:]$/, "");
  const choice = cleaned.match(/\(([^()]+\|[^()]+)\)/);
  if (!choice) return [cleaned];
  return choice[1].split("|").map((part) => cleaned.replace(choice[0], part));
}

function handlerOperations(file) {
  const text = fs.readFileSync(file, "utf8");
  const out = new Set();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*\/\/\s+([A-Z]+(?:\/[A-Z]+)*)\s+(\/\S+)/);
    if (!match) continue;
    const methods = match[1].split("/");
    const paths = expandHandlerPath(match[2]);
    for (const method of methods) {
      for (const routePath of paths) out.add(`${method} ${normalizePath(routePath)}`);
    }
  }
  return out;
}

function openApiOperations(file) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const out = new Set();
  let currentPath = null;
  for (const line of lines) {
    const pathMatch = line.match(/^  (\/[^:]+):\s*$/);
    if (pathMatch) {
      currentPath = pathMatch[1];
      continue;
    }
    const methodMatch = line.match(/^    (get|post|patch|put|delete):\s*$/i);
    if (currentPath && methodMatch) {
      out.add(`${methodMatch[1].toUpperCase()} ${normalizePath(currentPath)}`);
    }
  }
  return out;
}

function diff(left, right) {
  return [...left].filter((value) => !right.has(value)).sort();
}

const implemented = handlerOperations("lib/handlers.js");
if (!implemented.size) throw new Error("No annotated implemented endpoints were found.");

for (const schema of ["openapi.template.yaml", "openapi.generated.yaml"]) {
  const documented = openApiOperations(schema);
  const undocumented = diff(implemented, documented);
  const unimplemented = diff(documented, implemented);
  if (undocumented.length || unimplemented.length) {
    console.error(`OpenAPI mismatch in ${schema}:`);
    if (undocumented.length) {
      console.error("Implemented but undocumented:");
      for (const item of undocumented) console.error(`  - ${item}`);
    }
    if (unimplemented.length) {
      console.error("Documented but not annotated as implemented:");
      for (const item of unimplemented) console.error(`  - ${item}`);
    }
    process.exitCode = 1;
  }
}

if (!process.exitCode) {
  const gpt = parse(fs.readFileSync("openapi.gpt.yaml", "utf8"));
  assert.deepEqual(gpt, buildGptSchema(gpt.servers[0].url));
  assert.ok(Object.keys(gpt.paths).length <= 30);
  console.log(`OpenAPI matches ${implemented.size} implemented method/path operations.`);
}
