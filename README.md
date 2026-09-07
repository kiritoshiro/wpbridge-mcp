# SiteOne WordPress ↔ ChatGPT bridge

A deliberately restricted local API bridge for controlling WordPress posts
through a **private Custom GPT Action**.

## Included

- Read/search published posts and drafts
- Read full editable post content
- Create drafts
- Edit title/content/excerpt/slug/categories/tags/featured media
- List categories and tags
- Optional, separately gated publish/unpublish actions

## Deliberately NOT included

- Delete post
- Users or roles
- Plugins
- Themes
- Site settings
- Arbitrary WordPress REST proxy
- Arbitrary URL fetching
- Shell/PHP execution

## Files

- `server.js` — local bridge
- `.env.example` — configuration template
- `openapi.template.yaml` — Custom GPT Action schema template
- `scripts/render-openapi.mjs` — inserts your stable public tunnel URL
- `GPT-INSTRUCTIONS.txt` — instructions to paste into the Custom GPT
- `SETUP-WINDOWS.md` — complete Windows setup

Start with `SETUP-WINDOWS.md`.


## Authentication

The bridge accepts `Authorization: Bearer <BRIDGE_API_KEY>` (recommended for GPT Actions) and the legacy `X-Bridge-Key: <BRIDGE_API_KEY>` header for manual tests.
