import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const roots = ["server.js", "lib", "mcp", "scripts", "test"];
const files = [];

function visit(entry) {
  const stat = fs.statSync(entry);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(entry)) {
      if (name === "node_modules") continue;
      visit(path.join(entry, name));
    }
    return;
  }
  if (/\.(?:js|mjs)$/.test(entry)) files.push(entry);
}

for (const root of roots) visit(root);
files.sort();
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`Syntax OK for ${files.length} JavaScript files.`);
