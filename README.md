# Content Orchestrator

GitHub-first rebuild of the Light Radar blog operations app.

## Core goals

- GitHub is the source of truth for the Orchestrator code.
- Target runtime will not depend on ChatGPT Work.
- The current transition build still uses the legacy GPT Sites API Hub as a temporary Blogger/provider bridge.
- Mobile-first PWA control center.
- Writer → Critic → targeted Repair → Final Critic pipeline.
- Existing published Blogger posts can be repaired while preserving the original Blogger Post ID.
- Blogger writes are **disabled by default**.
- Existing production API Hub queues are outside this repository and remain untouched.

## Phase 1

1. Blogger connection contract
2. Blog list contract
3. Writer uses verified Master v4.5
4. Critic returns structured PASS/FAIL
5. Targeted Repair + Final Critic
6. Real private Blogger draft verification

Dashboard progress is derived from verification evidence, never hard-coded checkmarks.

## Current dashboard capabilities

The PWA source currently supports:

- Phase 1 progress display
- session-only admin-key connection
- protected job queue listing
- new-article job creation
- existing-published-post repair job creation
- queued job execution
- result/error inspection
- Cloudflare Workers AI diagnostic request through API Hub

The browser never embeds `ADMIN_API_KEY` in Git. The key is kept only in `sessionStorage` for the active browser session.

## API boundary

All third-party provider secrets remain in API Hub during the transition. Content Orchestrator talks to API Hub using the server-side `HUB_API_KEY`.

Current intended routing:

- Writer: API Hub → Cloudflare Workers AI → `@cf/openai/gpt-oss-120b`
- Repair: API Hub → Cloudflare Workers AI → `@cf/openai/gpt-oss-120b`
- Critic / Final Critic: API Hub → configured critic model
- Blogger: API Hub → Blogger API

The repository includes an API Hub compatibility adapter for Cloudflare Workers AI, but the matching route still has to be deployed into the legacy API Hub before live diagnostics can succeed.

## Existing-post repair safety

Existing published-post repair is a separate path from generation repair.

- source post is fetched by `blogId + bloggerPostId`
- Critic diagnoses the existing article
- only flagged sections are repaired
- Final Critic runs again
- original `blogId` and `bloggerPostId` must remain unchanged
- a changed Blogger Post ID aborts the update path
- the pipeline stops at `ready` until a separate publish/update approval step is used

## Master v4.5 integrity

The currently verified runtime prompt is pinned by:

- file name: `universal_blog_master_prompt_ko_en_verified_v4_5_final.md`
- size: `93,282 bytes`
- SHA-256: `0df7c83bb3874c4802ca7c02306beee7cd7032366930d66abfc7fa1bdb6cda66`

The legacy API Hub currently owns the executable prompt. The repository stores the immutable integrity manifest in `prompts/master-v4.5.integrity.json`. The full source snapshot has been re-verified locally against the hash above but has not yet been committed into this repository.

## Verification

No external packages are required for the current core tests.

```bash
npm run verify
```

This performs syntax checks, unit tests and a deterministic build. GitHub Actions also runs `npm run verify` on pushes to `main` and on pull requests.

## Deployment template

`wrangler.example.jsonc` contains the Cloudflare Worker + Static Assets + D1 template. Real account IDs, D1 IDs and secrets are intentionally excluded from Git.

## Safety defaults

- `BLOGGER_WRITES_ENABLED=false`
- mutation endpoints require `x-admin-api-key`
- no endpoint mutates the legacy API Hub queue
- no production DB migration or Blogger publish occurs during build/test
- job execution and Blogger publication remain separate operations
