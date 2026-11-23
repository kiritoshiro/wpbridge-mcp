# WPBridge MCP

The MCP gateway exposes selected WPBridge actions for explicitly configured sites. See [MCP-SETUP.md](../MCP-SETUP.md) for configuration, security, and connection steps.

`server.js` starts the stdio or loopback HTTP transport. HTTP requires OAuth unless `WPBRIDGE_MCP_LOCAL_TOKEN_HTTP=1` explicitly enables the static local token, which is for a client on the same machine only: never route a local-token HTTP port through a tunnel or proxy, because header checks reduce but cannot eliminate that risk. For HTTP, `http-guard.js` runs the path, duplicate-header, Host, proxy-header, Origin, method and throttle checks before `http-auth.js` verifies the local token or OAuth access token, and `server.js` closes the connection on every early response; see sections 3 and 4 of MCP-SETUP.md for the settings and what each check does.
