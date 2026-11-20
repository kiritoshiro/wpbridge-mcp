# WPBridge MEC Calendar Helper

Install and activate this helper in the WordPress site that runs Modern Events Calendar Lite. It exposes the fixed `wpbridge/v1/calendar/*` routes used by WPBridge.

The helper calls MEC's own `save_event()` method, so date indexes, recurrence data and MEC event tables stay synchronized. It acts as the authenticated WordPress user supplied by WPBridge, with the same permissions that user has in WordPress, taken from the `mec-events` post type and the MEC taxonomies:

- Listing shows other authors' published events, other authors' private events only with `read_private_posts`, and their drafts, pending and scheduled events only with `edit_others_posts`. The user's own events are always listed.
- Editing an event needs `edit_post` on it.
- Publishing, scheduling (including `scheduled_for_gmt`) or making an event private needs `publish_posts`.
- Setting another user as author needs `edit_others_posts`. Updates keep the existing author unless `author_id` is sent.
- Creating terms needs the taxonomy's `manage_terms`; assigning them needs `assign_terms`.

A refused request returns 403. If `ENFORCE_DEFAULT_AUTHOR=true` and `DEFAULT_AUTHOR` names a different user from the bridge's WordPress account, that account needs `edit_others_posts` (an Editor) to create events.

It intentionally exposes editorial event fields only: title/content, dates and times, recurrence, visibility, MEC taxonomies, locations/organizers, featured media and event gallery. Booking, ticket, payment and attendee data are not exposed.

After copying the directory to `wp-content/plugins/wpbridge-mec-helper/`, activate it in WordPress. Then set `CALENDAR_ENABLED=true` in WPBridge's `.env` and restart the bridge.
