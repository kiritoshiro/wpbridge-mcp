import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const serverPath = path.join(root, "mcp", "server.js");
if (!fs.existsSync(serverPath)) throw new Error("Run this script from a complete WPBridge checkout.");
if (!fs.existsSync(path.join(root, "node_modules", "@modelcontextprotocol", "sdk"))) {
  throw new Error("Run npm ci before configuring the local plugin.");
}
const configPath = process.env.WPBRIDGE_MCP_LOCAL_CONFIG ||
  path.join(os.homedir(), ".wpbridge-mcp", "local.json");
fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
fs.writeFileSync(configPath, JSON.stringify({ repo_root: root }) + "\n", { mode: 0o600 });
console.log(`Configured the local WPBridge plugin at ${configPath}.`);
console.log("Install or reinstall the plugin from its marketplace, then open a new Codex task.");
