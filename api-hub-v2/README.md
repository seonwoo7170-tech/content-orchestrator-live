# API Hub v2

Work-independent replacement for the legacy GPT Sites API Hub.

## Design

`Content Orchestrator -> API Hub v2 (Cloudflare Worker) -> external providers`

Phase 1 HTTP surface:

- `GET /health`
- `POST /api/hub/ai/diagnostics/cloudflare`
- `POST /api/hub/ai/writer`
- `POST /api/hub/ai/critic`
- `POST /api/hub/ai/repair`
- `POST /api/blogger/blogs`
- `POST /api/blogger/post/get`
- `POST /api/blogger/post`
- temporary OAuth bootstrap: `GET /oauth/google/start` and `GET /oauth/google/callback`

All operational API routes require `x-hub-api-key` to exactly match the single Worker secret `ORCHESTRATOR_API_KEY`. There is no legacy `HUB_API_KEY` fallback in v2. The temporary Google OAuth browser endpoints do not use the Hub header because browser navigation cannot safely supply it; instead they are available only during bootstrap mode and the callback is protected by a short-lived HMAC-signed state value derived from `ORCHESTRATOR_API_KEY`.

## AI provider routing

The three AI roles intentionally use different routing contracts:

- Writer: Cloudflare Workers AI primary, Gemini 3.5 Flash-Lite fallback.
- Critic / Final Critic: Gemini 3.5 Flash-Lite only.
- targeted Repair: Cloudflare Workers AI primary, Gemini 3.5 Flash-Lite fallback.

Writer and Repair attempt Gemini fallback only for known Cloudflare provider/runtime failures such as daily allocation exhaustion, out-of-capacity, provider timeout, binding failure, paid-plan requirement for the selected model, or an empty provider response. Input validation and model-ID validation errors are not hidden by fallback.

Critic deliberately does not fall back to Workers AI. If the Gemini API key is absent or Gemini cannot produce a valid Critic response, the Critic path fails closed instead of silently switching models. This keeps the publication gate tied to the tested Critic behavior.

## Workers AI

API Hub v2 uses Cloudflare's native Workers AI binding (`env.AI`) instead of calling the REST API with a separate provider token. This removes the runtime `CF_AI_API_TOKEN` and `CF_AI_ACCOUNT_ID` dependency entirely.

The Worker configuration declares:

```json
"ai": { "binding": "AI" }
```

Workers-hosted model IDs remain restricted to approved `@cf/` model IDs.

## Gemini 3.5 Flash-Lite

The Gemini provider uses the GenerateContent API with model `gemini-3.5-flash-lite` by default.

- Writer fallback: minimal thinking.
- Critic / Final Critic: dedicated provider, medium thinking, structured JSON output, granular separate-pass audit.
- targeted Repair fallback: medium thinking.

The Critic audit adapter explicitly separates materially different defects instead of combining unrelated repair actions. It independently checks title exaggeration and guarantees, unsupported absolute claims, fabricated statistics, fabricated or invalid visible sources, unsafe or destructive instructions, repetition/filler, malformed HTML, misleading search descriptions, and all other applicable Master v4.5 requirements. Server-side normalization still permits PASS only when score is at least 95 and `issues` is empty.

The API key is a Worker secret and is never returned by `/health` or operational routes. Provider error bodies are not exposed to callers.

## Master v4.5

The exact verified Master v4.5 body is bundled into the Worker source as deterministic gzip/base64 chunks. Runtime loading fails closed unless both checks match:

- SHA-256: `0df7c83bb3874c4802ca7c02306beee7cd7032366930d66abfc7fa1bdb6cda66`
- UTF-8 byte size: `93,282`

The original Master remains the immutable Source of Truth. Runtime role prompts are derived only by selecting complete top-level sections from that exact original, preserving every selected byte and original section order. Each role prompt has its own pinned byte size and SHA-256 and fails closed if it drifts:

- Writer: `60,075` bytes — `d72c959ba73cfaffff6582889d522201bfb55de2a81f461585c0dc352251609e`
- Critic: `65,993` bytes — `b9f1e03ab0bd6e65ae8206bfd8253083929677e16f3fda6d3c35ec2d50a077c5`
- Repair: `64,451` bytes — `10c9e4c2dd761e5c60e04394f8f904dde612539705ac65a2b74bd40544949b04`

No selected Master sentence is summarized, rewritten or paraphrased during derivation. Interactive platform-selection and unrelated execution-flow sections are omitted from automation role prompts instead of being rewritten.

Writer, Critic and Repair append only their server automation adapters after their verified role prompt. The Writer adapter requires one complete JSON Article and forbids interactive questions, placeholders, invented URLs, invented quotations, invented experience and unsupported current claims. The Critic uses the exact Critic role prompt plus the granular audit adapter; the underlying Master sections remain byte-exact.

## Critic validation evidence

The dedicated Gemini Critic is covered by unit/contract tests and no-write live controls on the feature branch.

- Deliberately defective fixture: FAIL with score 0; the actual Critic route repeatedly catches the core defect classes including clickbait/guarantees, fabricated statistics, destructive instructions, repetition, malformed HTML and fabricated sources.
- Granularity benchmark: has demonstrated up to seven separately reported defects on the same fixture.
- Clean evergreen control article: PASS with score 100 and zero issues.
- Critic calls do not invoke Workers AI.
- All live validation scripts set `writes: false`; no Blogger or production data write is part of these tests.

These controls validate the routing and the selected fixtures; they are not a claim that one model will outperform every other model on every article.

## Blogger

API Hub v2 has its own Google OAuth refresh-token adapter and does not depend on the legacy GPT Sites OAuth state.

Implemented read/write contracts:

- list connected Blogger blogs
- fetch an existing post by `blogId + bloggerPostId`
- create a new Blogger post, defaulting to draft
- update an existing Blogger post while requiring the same Post ID

Blogger writes remain disabled unless `BLOGGER_WRITES_ENABLED=true`.

### Two-step OAuth bootstrap

The production workflow intentionally supports a staged setup so the refresh token never has to be pasted into chat or committed to Git.

1. Configure only these two GitHub production environment secrets:
   - `API_HUB_V2_GOOGLE_CLIENT_ID`
   - `API_HUB_V2_GOOGLE_CLIENT_SECRET`
2. Deploy API Hub v2. The workflow detects the client pair without a refresh token and temporarily renders `GOOGLE_OAUTH_SETUP_ENABLED=true`.
3. Add this exact redirect URI to the Google OAuth Web application client:
   - `https://api-hub-v2.smileseon.workers.dev/oauth/google/callback`
4. Open:
   - `https://api-hub-v2.smileseon.workers.dev/oauth/google/start`
5. Approve the Blogger scope. The callback shows the refresh token once in a no-store page.
6. Save that value directly as GitHub production environment secret `API_HUB_V2_GOOGLE_REFRESH_TOKEN`.
7. Deploy API Hub v2 again. The workflow detects all three Google values and automatically renders `GOOGLE_OAUTH_SETUP_ENABLED=false`, then performs a read-only Blogger blog-list smoke test.

The OAuth start URL requests only `https://www.googleapis.com/auth/blogger`, offline access, and explicit consent. The callback never puts the refresh token in a URL, log, Git commit, or provider error response.

## Safety defaults

- `BLOGGER_WRITES_ENABLED=false`
- Blogger provider calls fail closed until all three Google OAuth values are configured.
- Client ID/secret alone enable only the temporary OAuth bootstrap flow; they do not make Blogger operational.
- OAuth bootstrap is automatically disabled when a refresh token is present.
- OAuth state is HMAC-signed and expires after 10 minutes.
- Google OAuth values, Gemini API key and the Orchestrator key are Worker secrets and are not returned by operational APIs.
- Dedicated Critic fails closed if Gemini is not configured or unavailable; it does not silently substitute Workers AI.
- Existing-post update aborts if Blogger returns a different Post ID.
- Deployment smoke requires Master v4.5 runtime integrity and Blogger writes to remain disabled.
- If Google OAuth is fully configured, deployment smoke performs only a read-only blog-list check; it never creates or updates a Blogger post.

## Runtime configuration

Required API Hub v2 Worker secrets:

- `ORCHESTRATOR_API_KEY`
- `GEMINI_API_KEY`

The Gemini secret is supplied from the GitHub production environment secret:

- GitHub secret: `API_HUB_V2_GEMINI_API_KEY`
- Worker secret: `GEMINI_API_KEY`

Cloudflare deployment still uses the repository's existing deployment credentials (`CLOUDFLARE_DEPLOY_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`) for Wrangler, but those values are not AI provider credentials inside the Worker.

Google OAuth GitHub production environment secrets:

- bootstrap pair:
  - `API_HUB_V2_GOOGLE_CLIENT_ID`
  - `API_HUB_V2_GOOGLE_CLIENT_SECRET`
- final connection:
  - `API_HUB_V2_GOOGLE_REFRESH_TOKEN`

The workflow permits Google OAuth states of none, client pair only, or full client pair plus refresh token. Partial client pairs and orphan refresh tokens fail closed.

## Models

Cloudflare Workers AI primary:

- Writer: `@cf/openai/gpt-oss-120b`
- targeted Repair: `@cf/openai/gpt-oss-120b`

Dedicated Critic / Final Critic:

- `gemini-3.5-flash-lite`

Gemini fallback for Writer / targeted Repair:

- `gemini-3.5-flash-lite`

## Verification

```bash
cd api-hub-v2
npm run verify
```

CI verifies both Content Orchestrator and API Hub v2 on every push to `main` and on pull requests.

The no-write Gemini validation workflow can exercise the dedicated Critic against a fault fixture and clean control without deploying the Worker or writing Blogger/D1 data.

The v2 deployment workflow is manual (`workflow_dispatch`) or trigger-file driven. Opening or updating the feature PR does not deploy API Hub v2.

This directory is kept inside the private `content-orchestrator` repository for the initial migration so it can be built without Work. It deploys as a separate Cloudflare Worker named `api-hub-v2`, so runtime isolation is preserved. It can be split into its own GitHub repository later without changing the HTTP contract.
