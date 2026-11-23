# WPBridge MCP

The MCP gateway exposes selected WPBridge actions for explicitly configured sites. See [MCP-SETUP.md](../MCP-SETUP.md) for configuration, security, and connection steps.

`server.js` starts the stdio or loopback HTTP transport. For HTTP, `http-guard.js` runs the path, Host, Origin, method and throttle checks before `http-auth.js` verifies the local token or OAuth access token; see section 4 of MCP-SETUP.md for remote settings and what each check does.
