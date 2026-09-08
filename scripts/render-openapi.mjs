import fs from "node:fs";
import path from "node:path";
import { stringify } from "yaml";
import { buildGptSchema } from "../lib/gpt-api.js";

function loadEnvFile(file = ".env") {
  const full = path.resolve(process.cwd(), file);
  if (!fs.existsSync(full)) return;
  for (const rawLine of fs.readFileSync(full, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile();
const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
if (!/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?$/.test(base)) {
  throw new Error("PUBLIC_BASE_URL must be a simple HTTPS origin, e.g. https://wpbridge.site-one.example");
}
const template = fs.readFileSync("openapi.template.yaml", "utf8");
fs.writeFileSync("openapi.generated.yaml", template.replaceAll("__PUBLIC_BASE_URL__", base));
console.log(`Created openapi.generated.yaml for ${base}`);
fs.writeFileSync("openapi.gpt.yaml", stringify(buildGptSchema(base), { aliasDuplicateObjects: false }));
console.log(`Created openapi.gpt.yaml with 12 operations for ${base}`);
