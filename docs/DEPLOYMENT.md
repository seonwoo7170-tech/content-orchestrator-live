# Cloudflare deployment runbook

This repository keeps runtime provider secrets out of Git.

## Two different Cloudflare credentials

Do not reuse the Workers AI token stored in the legacy API Hub as the GitHub deployment credential unless that token was intentionally granted deployment permissions.

1. **Workers AI runtime token**
   - lives in API Hub
   - used by API Hub to call Workers AI models
   - current intended Writer/Repair model: `@cf/openai/gpt-oss-120b`

2. **Cloudflare deployment token**
   - lives only in GitHub Actions secrets
   - used by Wrangler to create/read D1 resources and deploy the Worker
   - should be scoped to the target account with Workers Scripts write access and D1 edit access

## GitHub Actions secrets required for manual deployment

Create these repository or `production` environment secrets before running `deploy-cloudflare`:

- `CLOUDFLARE_DEPLOY_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `HUB_API_KEY`
- `ADMIN_API_KEY`

No third-party provider key is required in Content Orchestrator. Provider credentials remain behind API Hub.

`HUB_API_KEY` and `ADMIN_API_KEY` are declared as required Worker secrets. The deploy workflow writes them to a temporary JSON file with restrictive permissions, sends them with the Worker deployment using Wrangler's `--secrets-file`, and deletes the temporary file even when deployment fails. The secret values are never printed by repository scripts.

## What the workflow does

The manual `.github/workflows/deploy-cloudflare.yml` workflow:

1. runs `npm run verify`
2. checks required deployment/runtime secrets exist without printing them
3. lists D1 databases and reuses `content-orchestrator` when present
4. creates the D1 database in the APAC location when it does not exist
5. renders `wrangler.jsonc` from `wrangler.example.jsonc`
6. applies remote D1 migrations
7. deploys the Worker, static PWA assets, `HUB_API_KEY`, and `ADMIN_API_KEY` together
8. resolves the account's `workers.dev` hostname
9. verifies `/health`
10. calls `/api/diagnostics/cloudflare-ai` exactly once through Content Orchestrator
11. reports only HTTP status, provider/model metadata, and pass/fail; no secret values are printed
12. removes generated deploy files

The workflow is **manual only** (`workflow_dispatch`) and uses a production concurrency lock. Normal commits do not deploy production automatically.

## Why the post-deploy diagnostic matters

The diagnostic follows the intended runtime path instead of the GPT Sites owner console path:

`Content Orchestrator Worker -> HUB_API_KEY -> API Hub -> Cloudflare Workers AI`

This avoids the owner-console identity-token limitation that blocked the earlier Work-based diagnostic. A failed diagnostic stops the workflow after reporting a sanitized status; it does not fall through to Blogger writes or legacy queue mutations.

## Safety defaults after deployment

- `BLOGGER_WRITES_ENABLED=false`
- job execution can generate/review/repair content but does not publish automatically
- existing-post repair preserves the original Blogger Post ID
- legacy API Hub queues are not migrated or mutated by this deployment
- the smoke test does not call Blogger create/update/publish

## Current API Hub dependency

The legacy API Hub now has the compatibility contracts expected by Content Orchestrator:

- `/api/hub/ai/diagnostics/cloudflare`
- `/api/hub/ai/writer`
- `/api/hub/ai/critic`
- `/api/hub/ai/repair`
- `/api/blogger/blogs`
- `/api/blogger/post/get`

Live verification is still pending until Content Orchestrator is deployed with its own server-side `HUB_API_KEY` secret. The first successful post-deploy smoke test will confirm the Cloudflare Workers AI credential path without using Work.
