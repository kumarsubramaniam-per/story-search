# CLAUDE.md — story-search

Local learning project: semantic search and RAG over a private collection of documents ("stories"), using Milvus (vector DB) and OpenAI, with optional Elasticsearch keyword search and hybrid search (RRF). The project is content-agnostic (see "Keep it generic").

- **What to build:** `spec.md` is the source of truth (scope, data model, API, milestones, decisions).
- **Environment setup:** `SETUP.md` (Docker, Milvus, `.env`, OpenAI key). The prework is already done when you start.

## How to work

- Work **one milestone at a time** (spec §9). When a milestone is done, stop and summarize what you built and how to verify it. Don't start the next milestone without being asked.
- Propose a short plan before writing code for a milestone.
- **Ask before installing any package** or adding a dependency not named in the spec.
- Prefer small, readable code over clever abstractions; this is a learning project, so explain non-obvious Milvus/OpenAI calls briefly in comments.
- If the spec is ambiguous or seems wrong, ask rather than guess. Don't silently change decisions recorded in spec §11.

## Keeping the spec current

`spec.md` must always describe what the code actually does.

- At the end of each milestone, before the summary and commit, compare the work with the spec and update every section that now differs or that the work extended: §3 flows, §4 architecture, §5 data model, §6 API, §7 results, §8 guardrails, §9 milestone status, §10 layout, and new decisions in §11. Bump the version line.
- Record only real deviations and additions; don't restate what is already accurate.
- Never silently change or remove an existing §11 decision. If the work contradicts one, ask first, then record the change and the reason.
- Commit the spec changes together with the milestone, and list them in the milestone summary.
- If the work changes the setup steps, say so and ask before editing `SETUP.md`.

## Keep it generic

Anyone should be able to use this project for their own content by setting environment variables and pointing `STORIES_DIR` at their files. A "story" is any self-contained piece of content small enough to embed as one chunk (article, note, FAQ entry, Q&A...).

- Nothing in code, prompts, UI text, comments, docs, tests or commit messages may be specific to one dataset or domain. Use neutral words ("story", "collection", "document") and made-up neutral examples.
- Never put real story titles, ids, names or text from `STORIES_DIR` in the repo, even in a comment or example. That includes screenshots and example output in docs: render them with made-up sample stories, never a screenshot of the real collection.
- Don't hardcode a document layout (header shapes, marker phrases, id formats) or assume an id shape. Anything specific to one collection is configuration: an env variable (name in `.env.example`) or a file in `STORIES_DIR`.
- Before finishing a milestone, grep the changes for domain-specific words and for hardcoded layouts, and fix what you find.

## Testing

- **Every change to logic ships with unit tests in the same PR.** New or changed functions, branches, error paths and edge cases get vitest tests (`*.test.ts`, next to the code). Don't open a PR until `npm test` passes and the new logic is covered; say in the milestone summary what the tests cover and what they deliberately don't.
- Tests are offline and free: mock OpenAI, Milvus and Elasticsearch; never call a real service or spend tokens. Use `inject()` for Fastify routes.
- Fixtures are made-up neutral text, never story text from `STORIES_DIR` (see "Keep it generic"). Tests must not write to the real `logs/activity.log` or `STORIES_DIR`.
- If a test exposes a bug, report it before changing behavior; don't quietly adjust the test to match.
- Fixing a bug means adding a test that fails without the fix.

## Do not touch

- **`docker-compose.yml`**: don't modify, regenerate or re-download it. It contains a required MinIO image fix (see SETUP.md §5) and the Elasticsearch service the user approved in milestone 6.
- **`SETUP.md`**: only edit when asked.
- **`spec.md`**: keep it current (see "Keeping the spec current"), but never change or remove an existing §11 decision without asking; new decisions may be added.
- **`docs/sdd-journey.md`**: the author's personal write-up of how this project was built, kept for publishing. Do not read, edit, rewrite, summarize or quote it until the user says so. Exclude it from searches and audits too (for example `git grep ... ':!docs/sdd-journey.md'`).
- **`volumes/`**: Milvus data (the folder under `DOCKER_VOLUME_DIRECTORY`, see SETUP.md §5); never edit or delete unless asked.

## Secrets and private data

- Never print, log, echo or commit the contents of `.env` or the API key. Read config via environment variables only.
- `.env` lives at the repo root and is git-ignored; keep `.env.example` in sync (names only, no values).
- Story documents live **outside the repo** in `STORIES_DIR`. Read them from there; never copy story text into the repo, fixtures, tests or logs.
- The activity log (`logs/activity.log`, git-ignored) must never contain query, question, story or answer text: log lengths, counts and timings only (spec §8). Keep that true when adding log fields.
- Don't commit generated data, embeddings or Milvus volumes. Generated files derived from stories (such as the eval embedding cache) go in the hidden `STORIES_DIR/.story-search/` folder, never in the repo.

## Stack and conventions

- **TypeScript on Node**, npm workspaces monorepo (`packages/*`), shared `tsconfig.base.json`. Run TS with `tsx` (no build step needed while learning).
- **Backend:** Fastify (`packages/api`).
- **Env loading:** one root `.env`, loaded by explicit path (npm workspace scripts run from inside each package folder, so default `dotenv` lookup won't find it).
- **Milvus:** `@zilliz/milvus2-sdk-node`, server at `localhost:19530`. Collection `stories`, schema per spec §5. Index **FLAT**, metric **COSINE**.
- **Elasticsearch (optional keyword search):** `@elastic/elasticsearch` 9.4.x against the 9.4.8 container, enabled by `ELASTICSEARCH_URL`. Index `stories`, same `chunk_id`s as Milvus. Local only: security is off and the port is bound to `127.0.0.1`. Search method is a `mode` (`vector`, `keyword`, or `hybrid`, which fuses both with reciprocal rank fusion in `fusion.ts`); keep the code working with Elasticsearch unset.
- **Embeddings:** `text-embedding-3-small`, 1536 dimensions, one chunk per story.
- **Generation:** OpenAI **Chat Completions API** (`/v1/chat/completions`), model from `CHAT_MODEL`. Do **not** use the Responses API; the project's API key is restricted to Chat Completions and Embeddings only.
- **Defaults:** k = 3.

## Cost guardrails (spec §8)

- Log `usage` token counts for every embedding and chat call.
- Cap chat output with `max_completion_tokens` (newer models reject `max_tokens`); pre-count prompt tokens and reject oversized prompts.
- Re-embed only new or changed stories (compare `content_hash`).
- Don't run ingest or eval in loops or retries that could call the API repeatedly without asking.

## Useful commands

```bash
./scripts/dev-up.sh          # start Docker Desktop + Milvus + Elasticsearch, wait until healthy
./scripts/dev-down.sh        # stop the containers, quit Docker Desktop (data kept)
docker compose ps            # container status
docker compose logs -f standalone   # Milvus logs
curl http://localhost:9091/healthz  # Milvus health (expects OK)

npm run check:milvus         # connect to Milvus and print its version
npm test                     # unit tests (vitest): offline, no Docker, no API calls
npm run ingest:dry           # parse and chunk only; no OpenAI or Milvus calls
npm run ingest -- [--rebuild] [--batch-size N]   # embed new/changed stories into Milvus
npm run api                  # Fastify server + web page at http://127.0.0.1:3000
tail -f logs/activity.log    # activity log: one JSON line per request, ingest run and server start/stop
npm run eval -- [--ask] [--mode vector|keyword|hybrid] [--compare] [--pool N] [--via http] [--no-cache]   # search eval; --compare = 3 methods side by side; --ask makes paid chat calls
```
