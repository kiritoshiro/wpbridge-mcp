# Grouped GPT API

Run `npm ci` after updating, then restart the bridge. Set `PUBLIC_BASE_URL` in
`.env` to your HTTPS bridge origin and run `npm run render-openapi`.
Import **openapi.gpt.yaml** in the Custom GPT editor and refresh its instructions
from GPT-INSTRUCTIONS.txt. Keep bearer API-key authentication configured.

The generated GPT schema has 12 grouped operations representing 82 restricted actions,
plus the direct conversation-file upload operation.
The full `openapi.template.yaml` and `openapi.generated.yaml` still describe the
original REST endpoints. No original endpoint has been removed.

Each group accepts a discriminated input with `action`, optional `path` and
`query` objects, and the action's original `body`. Each action has its own typed
schema variant. For example, POST `/gpt/contentRead`:

```json
{"action":"getPost","path":{"post_id":123}}
```

POST `/gpt/contentCreate`:

```json
{"action":"createDraft","body":{"title":"Example draft","idempotency_key":"example-draft-001"}}
```

Action names are fixed, and must belong to the selected group. URLs and methods
cannot be supplied. Path values cannot contain separators or traversal. All
requests require authentication, including grouped health reads. The existing
rate limit is charged once per call. Requests reuse the original handlers,
including confirmation strings, allowlists, live-edit and publishing gates,
preview/version guards, idempotency stores and activity tracking. Response bodies
and HTTP status codes are those of the selected original action.

Groups containing any write action are conservatively marked consequential, so
the editor may request confirmation for their read-only variants too.

CI tests full action coverage, the operation limit, schema generation, dispatcher
rejection cases and handler security. The generated schema must still be imported
and exercised in your GPT editor; local checks cannot prove editor compatibility.
