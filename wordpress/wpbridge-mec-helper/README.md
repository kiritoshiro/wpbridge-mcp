# WPBridge MEC Calendar Helper

Install and activate this helper in the WordPress site that runs Modern Events Calendar Lite. It exposes the fixed `wpbridge/v1/calendar/*` routes used by WPBridge.

The helper calls MEC's own `save_event()` method, so date indexes, recurrence data and MEC event tables stay synchronized. It uses the authenticated WordPress user supplied by WPBridge and applies `edit_post`/`edit_posts` capability checks.

It intentionally exposes editorial event fields only: title/content, dates and times, recurrence, visibility, MEC taxonomies, locations/organizers, featured media and event gallery. Booking, ticket, payment and attendee data are not exposed.

After copying the directory to `wp-content/plugins/wpbridge-mec-helper/`, activate it in WordPress. Then set `CALENDAR_ENABLED=true` in WPBridge's `.env` and restart the bridge.
