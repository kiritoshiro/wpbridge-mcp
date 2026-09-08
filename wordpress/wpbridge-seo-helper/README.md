# WPBridge SEO Helper

Optional WordPress helper plugin used by wpbridge v1.5.0 for safe SEO metadata reads/writes.

Install this folder as a WordPress plugin and activate it. The helper exposes only these authenticated fields for posts/pages that the current WordPress user can edit:

- SEO title
- Meta description
- Focus keyword
- Canonical URL
- Open Graph title
- Open Graph description

Supported providers: Yoast SEO and Rank Math SEO.

The helper does not expose arbitrary post meta, plugin settings, users, or generic REST proxying.
