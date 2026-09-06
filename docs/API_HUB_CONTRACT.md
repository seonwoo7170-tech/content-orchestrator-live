# API Hub contract required by Content Orchestrator

Content Orchestrator sends `x-hub-api-key` on every Hub request. Provider secrets never leave API Hub.

The following routes are configurable through environment variables so the current API Hub can adopt them without coupling the Orchestrator to one implementation.

## Blogger connected blogs

`POST HUB_BLOGGER_BLOGS_PATH` (default `/api/blogger/blogs`)

Request body:

```json
{ "action": "list" }
```

Accepted response shapes include a top-level array or an object containing `blogs`, `items`, or `result`. Each item must expose a Blogger ID using `blogId` or `id`; display name may use `blogName`, `name`, or `title`.

The Orchestrator exposes this as authenticated `GET /api/blogs` for the PWA. If the current API Hub uses a different existing list route, only `HUB_BLOGGER_BLOGS_PATH` or the Hub adapter needs to change.

## Writer

`POST HUB_WRITER_PATH` (default `/api/hub/ai/writer`)

Returns an Article object with at least: `title`, `html`, `searchDescription`, `labels`, `sources`, `language`, `topic`.

## Critic

`POST HUB_CRITIC_PATH` (default `/api/hub/ai/critic`)

Returns:

```json
{
  "status": "PASS|FAIL",
  "issues": [
    {
      "code": "SOURCE_WEAK",
      "severity": "HIGH",
      "location": "section identifier",
      "reason": "why it failed",
      "repairInstruction": "what to change"
    }
  ]
}
```

PASS must have zero issues. FAIL must have one or more issues.

## Targeted repair

`POST HUB_REPAIR_PATH` (default `/api/hub/ai/repair`)

Receives the original Article plus Critic issues and `strategy=targeted_sections_only`. It must preserve unaffected sections.

## Cloudflare Workers AI diagnostic

`POST HUB_CLOUDFLARE_DIAGNOSTIC_PATH` (default `/api/hub/ai/diagnostics/cloudflare`)

API Hub uses its own `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` to call `@cf/openai/gpt-oss-120b`. This route is the safe verification path for the values entered in API Hub site settings.

## Blogger fetch existing post

`POST HUB_BLOGGER_GET_PATH` (default `/api/blogger/post/get`)

Receives `blogId` and `bloggerPostId`. It must return the existing article and the same identity. Content Orchestrator rejects a response whose Blogger Post ID changes.

## Blogger publish/update

The existing Blogger route can remain `/api/blogger/post`. Existing-post repair must pass the original `bloggerPostId` and perform UPDATE semantics; it must not create a new post.
