import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const configPath = process.env.WPBRIDGE_MCP_LOCAL_CONFIG ||
  path.join(os.homedir(), ".wpbridge-mcp", "local.json");

try {
  const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const root = saved.repo_root;
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw new Error("Invalid local WPBridge checkout path.");
  }
  const serverPath = path.join(root, "mcp", "server.js");
  if (!fs.existsSync(serverPath)) throw new Error("WPBridge MCP server is missing from the configured checkout.");
  const { main } = await import(pathToFileURL(serverPath).href);
  await main(["--stdio"]);
} catch (error) {
  console.error(error.message);
  console.error("Run npm run mcp:configure-local in your WPBridge checkout, then open a new Codex task.");
  process.exitCode = 1;
}
