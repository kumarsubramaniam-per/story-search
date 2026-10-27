# CLAUDE.md — story-search

Local learning project: semantic search and RAG over an interview story bank, using Milvus (vector DB) and OpenAI, with Elasticsearch hybrid search in v2.

- **What to build:** `spec.md` is the source of truth (scope, data model, API, milestones, decisions).
- **Environment setup:** `SETUP.md` (Docker, Milvus, `.env`, OpenAI key). The prework is already done when you start.

## How to work

- Work **one milestone at a time** (spec §9). When a milestone is done, stop and summarize what you built and how to verify it. Don't start the next milestone without being asked.
- Propose a short plan before writing code for a milestone.
- **Ask before installing any package** or adding a dependency not named in the spec.
- Prefer small, readable code over clever abstractions; this is a learning project, so explain non-obvious Milvus/OpenAI calls briefly in comments.
- If the spec is ambiguous or seems wrong, ask rather than guess. Don't silently change decisions recorded in spec §11.

## Do not touch

- **`docker-compose.yml`**: don't modify, regenerate or re-download it. It contains a required MinIO image fix (see SETUP.md §5).
- **`spec.md` and `SETUP.md`**: only edit when asked.
- **`volumes/`**: Milvus data; never edit or delete unless asked.

## Secrets and private data

- Never print, log, echo or commit the contents of `.env` or the API key. Read config via environment variables only.
- `.env` lives at the repo root and is git-ignored; keep `.env.example` in sync (names only, no values).
- Story documents live **outside the repo** in `STORIES_DIR`. Read them from there; never copy story text into the repo, fixtures, tests or logs.
- Don't commit generated data, embeddings or Milvus volumes.

## Stack and conventions

- **TypeScript on Node**, npm workspaces monorepo (`packages/*`), shared `tsconfig.base.json`. Run TS with `tsx` (no build step needed while learning).
- **Backend:** Fastify (`packages/api`).
- **Env loading:** one root `.env`, loaded by explicit path (npm workspace scripts run from inside each package folder, so default `dotenv` lookup won't find it).
- **Milvus:** `@zilliz/milvus2-sdk-node`, server at `localhost:19530`. Collection `stories`, schema per spec §5. Index **FLAT**, metric **COSINE**.
- **Embeddings:** `text-embedding-3-small`, 1536 dimensions, one chunk per story.
- **Generation:** OpenAI **Chat Completions API** (`/v1/chat/completions`), model from `CHAT_MODEL`. Do **not** use the Responses API; the project's API key is restricted to Chat Completions and Embeddings only.
- **Defaults:** k = 3.

## Cost guardrails (spec §8)

- Log `usage` token counts for every embedding and chat call.
- Set `max_tokens` on chat calls; pre-count prompt tokens and reject oversized prompts.
- Re-embed only new or changed stories (compare `content_hash`).
- Don't run ingest or eval in loops or retries that could call the API repeatedly without asking.

## Useful commands

```bash
./scripts/dev-up.sh          # start Docker Desktop + Milvus, wait until healthy
./scripts/dev-down.sh        # stop Milvus, quit Docker Desktop (data kept)
docker compose ps            # container status
docker compose logs -f standalone   # Milvus logs
curl http://localhost:9091/healthz  # Milvus health (expects OK)
```
