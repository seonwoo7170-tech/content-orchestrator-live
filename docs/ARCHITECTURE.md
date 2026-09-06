# Architecture

## Control plane

The PWA and ChatGPT-originated commands create jobs in Content Orchestrator. Content Orchestrator owns job state and verification evidence.

## API Hub boundary

All third-party provider secrets remain in API Hub. Content Orchestrator only stores `HUB_API_KEY` and the API Hub base URL.

Provider routing:

- Writer: API Hub -> Cloudflare Workers AI -> `@cf/openai/gpt-oss-120b`
- Critic: API Hub -> configured critic model
- Repair: API Hub -> Cloudflare Workers AI -> `@cf/openai/gpt-oss-120b`
- Blogger: API Hub -> Blogger API

## Two repair paths

1. Generation repair: repair only Critic-flagged sections before publication.
2. Existing published post repair: fetch an existing Blogger post, diagnose it, repair only required sections, run Final Critic, then update the **same Blogger Post ID**. It must never create a replacement post.

## Safety

Blogger writes are disabled by default. Existing production API Hub DB and its old queue are outside this repository and are never mutated by migration or tests here.
