# API Hub — Cloudflare Workers AI contract

Content Orchestrator never receives Cloudflare credentials. API Hub owns them and exposes a narrow internal route protected by the existing `x-hub-api-key` boundary.

## Secrets stored only in API Hub

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`

Do not commit either value to GitHub.

## Pinned model roles

- Writer / Repair: `@cf/openai/gpt-oss-120b`
- Critic / Final Critic candidate: `@cf/zai-org/glm-4.7-flash`

The implementation in `api-hub-adapters/cloudflare-workers-ai.js` allowlists only these model IDs by default.

## Required diagnostic route

`POST /api/hub/ai/diagnostics/cloudflare`

Request:

```json
{
  "model": "@cf/openai/gpt-oss-120b",
  "prompt": "Reply only with OK"
}
```

The Hub must call Cloudflare REST:

`POST https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run/@cf/openai/gpt-oss-120b`

using `Authorization: Bearer {CLOUDFLARE_API_TOKEN}` and a `messages` array.

Return only a redacted result:

```json
{
  "ok": true,
  "provider": "cloudflare-workers-ai",
  "model": "@cf/openai/gpt-oss-120b",
  "response": "OK",
  "usage": {}
}
```

Never return the token, Account ID, request headers, or raw environment values.

## Required AI routes

The Orchestrator expects these configurable Hub routes:

- `POST /api/hub/ai/writer`
- `POST /api/hub/ai/critic`
- `POST /api/hub/ai/repair`
- `POST /api/hub/ai/diagnostics/cloudflare`

Writer and Repair should route to GPT-OSS 120B. Critic and Final Critic can route to GLM-4.7-Flash after benchmark validation.

## Existing published post fetch

Existing-post repair additionally expects:

`POST /api/blogger/post/get`

with:

```json
{
  "blogId": "...",
  "bloggerPostId": "..."
}
```

The response must include the exact same `blogId` and `bloggerPostId` plus an Article object. Content Orchestrator rejects a changed Post ID before repair continues.

## Write safety

A repair result must update the same Blogger Post ID. Creating a replacement post is forbidden. Blogger writes remain disabled in Content Orchestrator until `BLOGGER_WRITES_ENABLED=true` is explicitly configured after Phase 1 read-only verification.
