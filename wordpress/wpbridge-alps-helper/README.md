# WPBridge ALPS Helper

Install and activate this small plugin on a site using the Adventist Living Pattern System theme. It exposes only the fixed ALPS controls supported by WPBridge:

- `large_banner`: `none`, `hero_50_50`, or `image_text_overlay`
- `hide_featured_image`: boolean

It maps those names to ALPS's real `_featured_image_hero_layout` and `_hide_featured_image` metadata, checks `edit_post`, and requires the current `alps_sha256` fingerprint for writes. It does not expose arbitrary post meta.

The write route accepts `POST`, which is the method used by WPBridge. After
updating this plugin, copy the file to the site's `wp-content/plugins/wpbridge-alps-helper/`
directory and reactivate it if WordPress does not reload the plugin automatically.
