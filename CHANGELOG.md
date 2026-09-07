# Changelog

## 1.0.2

- Added standard Bearer authentication for GPT Actions.
- Kept `X-Bridge-Key` support for backwards compatibility/manual testing.
- Updated OpenAPI security scheme to HTTP Bearer.

## 1.0.1

- Fixed the `createDraft` OpenAPI request schema for ChatGPT Actions.
- Replaced the `allOf` composition with a single explicit object schema so the action is no longer skipped by the schema validator.
- Inlined the `updatePost` request object too, avoiding request-body `$ref` parsing differences in GPT Actions.
