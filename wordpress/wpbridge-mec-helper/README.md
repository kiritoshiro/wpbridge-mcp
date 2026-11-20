# WPBridge MEC Calendar Helper

Install and activate this helper in the WordPress site that runs Modern Events Calendar Lite. It exposes the fixed `wpbridge/v1/calendar/*` routes used by WPBridge.

The helper calls MEC's own `save_event()` method, so date indexes, recurrence data and MEC event tables stay synchronized. It acts as the authenticated WordPress user supplied by WPBridge, with the same permissions that user has in WordPress, taken from the `mec-events` post type and the MEC taxonomies:

- Listing shows other authors' published events, other authors' private events only with `read_private_posts`, and their drafts, pending and scheduled events only with `edit_others_posts`. The user's own events are always listed.
- Reading one event needs `read_post` on it. Editing it needs `edit_post`. An event the user may not read gets the same 404 as an ID that does not exist.
- Creating an event needs the post type's `create_posts`.
- Publishing, scheduling (including `scheduled_for_gmt`) or making an event private needs `publish_posts`.
- Setting another user as author needs `edit_others_posts`. Updates keep the existing author unless `author_id` is sent.
- Creating terms needs the taxonomy's `manage_terms`; assigning them needs `assign_terms`.

A refused request returns 403. If `ENFORCE_DEFAULT_AUTHOR=true` and `DEFAULT_AUTHOR` names a different user from the bridge's WordPress account, that account needs `edit_others_posts` (an Editor) to create events.

It intentionally exposes editorial event fields only: title/content, dates and times, recurrence, visibility, MEC taxonomies, locations/organizers, featured media and event gallery. Booking, ticket, payment and attendee data are not exposed.

## Recurrence values

MEC writes some recurrence values into its own database table without escaping them, so the helper accepts only these forms and rejects anything else with 400 before it writes:

| Field | Accepted values |
| --- | --- |
| `repeat.weekdays` | Weekday numbers 1 (Monday) to 7 (Sunday), as an array or a comma-separated string. |
| `repeat.not_in_days` | Up to 366 `YYYY-MM-DD` dates, as an array or a comma-separated string. |
| `repeat.in_days` | Up to 366 `START:END` date pairs (`YYYY-MM-DD`), each optionally followed by `:HH-MM-AM:HH-MM-PM` times. |
| `repeat.advanced_days` | Tokens such as `Mon.1` (first Monday) to `Sat.4`, or `Fri.l` (last Friday), as an array or a `-`-separated string. |

Term, location, organizer, featured-image and gallery IDs are checked before the event is saved, so an unknown ID leaves the event unchanged.

## Installation

After copying the directory to `wp-content/plugins/wpbridge-mec-helper/`, activate it in WordPress. Then set `CALENDAR_ENABLED=true` in WPBridge's `.env` and restart the bridge.

## Changelog

### 1.0.2

- Security: recurrence values are validated strictly and rebuilt by the helper before MEC writes them into SQL. Earlier versions passed `weekdays`, `in_days` and `not_in_days` through as text, so a user who could edit an event could change other rows in MEC's events table.
- MEC's save leaves out the author, password and other post fields, so WordPress used to reset them on every edit. Edits now keep the event's author (or apply a permitted `author_id`), password, slug, date, parent, menu order and comment settings, and the helper checks the saved author, status and password afterwards.
- Scheduling saves the event once, straight to `future` with its date. Earlier versions published it first, which ran publication hooks.
- Creating needs `create_posts`. Reading one event needs `read_post` instead of `edit_post`, and hidden events return 404.
- Unknown term and media IDs are rejected before the save, not after a partial write.
- Custom-day recurrences now reach MEC's `days` column, and advanced-day recurrences are stored in MEC's array format.

### 1.0.1

- Security: authorization uses the `mec-events` post type and MEC taxonomy capabilities. Disallowed writes return 403.
