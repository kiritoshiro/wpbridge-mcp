# WPBridge Control

Install this folder as a WordPress plugin on a site whose WPBridge instance needs selected site controls. It adds four authenticated REST operations under `/wp-json/wpbridge-control/v1`: read/update selected site settings and list/update installed plugins.

The bridge uses a separate WordPress account and Application Password for these operations. WordPress capabilities are checked on every route. The settings writer requires the fingerprint returned by the read operation and `confirm: UPDATE_SITE_SETTINGS`. The plugin updater requires the exact installed plugin filename, installed version, and `confirm: UPDATE_PLUGIN`.

The plugin has no AI model or remote connection of its own. The bridge and MCP gateway enforce their own distinct keys and site permissions. See `MCP-SETUP.md` in the repository root.
