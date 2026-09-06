# Cloudflare deployment

The app is designed as one Cloudflare Worker plus Static Assets and one D1 database.

## 1. Create D1

Create a D1 database named `content-orchestrator` and copy its database ID.

Copy `wrangler.example.jsonc` to `wrangler.jsonc`, then replace only `REPLACE_WITH_D1_DATABASE_ID`.

## 2. Add server-only secrets

Set these as Worker secrets, never as public vars and never in GitHub:

- `HUB_API_KEY` — existing API Hub authentication key
- `ADMIN_API_KEY` — separate operator key for mutation/run endpoints

`BLOGGER_WRITES_ENABLED` remains `false` through Phase 1.

## 3. Apply D1 migration

Apply migrations from `worker/migrations` to the `content-orchestrator` D1 database.

## 4. Deploy

The Worker runs first only for `/api/*` and `/health`. Files under `web/` are served as static assets, so the same deployment gives a mobile web/PWA control center and the API runtime.

## 5. First checks

Before any Blogger write is enabled:

1. `GET /health`
2. `GET /api/phase1`
3. Admin-protected `POST /api/diagnostics/cloudflare-ai`
4. Confirm the API Hub returns `OK` from `@cf/openai/gpt-oss-120b`
5. Keep `BLOGGER_WRITES_ENABLED=false`

Only after read-only Writer/Critic/Repair verification should a private Blogger draft test be approved.
