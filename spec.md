# Story Search — Spec (v0.6)

*Status: milestones 1–5 are built (see §9). §§3–8 and 10 describe what is built unless marked v2.*

## 1. Goal
Build a small local application to learn Milvus vector search and retrieval-augmented generation (RAG) over a private collection of short documents. The project is content-agnostic: a **story** is any self-contained piece of content small enough to embed as one chunk (an article, note, FAQ entry, Q&A, case study…). The first test set is ~20–30 stories of ~700 words each. Later, add Elasticsearch keyword search and fuse both result sets (hybrid search).

## 2. Scope
**In scope (v1)**
- Ingest story documents (`.pdf`, `.txt`, `.md`) in one file or many, one chunk per story; a file holds one story or several
- Embed chunks with OpenAI `text-embedding-3-small` (1536 dims)
- Store vectors + text + metadata in Milvus
- Semantic search endpoint (top-k stories)
- Ask endpoint: retrieve top-k, send to LLM, answer grounded only in retrieved context, with cited story IDs
- Minimal web page calling the backend (Search/Ask toggle, in-page history)
- Run everything locally on Mac

**Later (v2)**
- Elasticsearch BM25 index over the same chunks
- Hybrid search with Reciprocal Rank Fusion (RRF)
- Optional: compare with Milvus built-in BM25 full-text search
- Optional: section-level chunking if story-level vectors prove too blurry
- Future direction: generalize into a knowledge-base agent over any private document set

**Out of scope**
- Auth, multi-user, cloud deployment
- Real-time document sync

## 3. User Flows
**Search:** user types a query → backend embeds query → Milvus returns top-k chunks → page shows story title, snippet, score. Hits scoring below `MIN_SCORE` (if set) are dropped, so an unrelated query can return nothing ("No close matches").

**Ask:** user types a question → backend retrieves top-k chunks → builds prompt (system instruction: answer only from context, cite story IDs like `[id]`, write plain text, and reply exactly "Not found in the collection." otherwise) → LLM returns answer → page shows answer plus source stories (cited ones marked). The citations are checked against the retrieved set. If no retrieved story scores above `MIN_SCORE`, the chat call is skipped and the reply is "Not found in the collection." with `noMatches: true`.

**Ingest (CLI):** read story files → split into chunks → for each batch: look up stored `content_hash`es, embed only new/changed chunks, upsert into Milvus → delete rows for stories no longer in that source file (later also index into Elasticsearch).

*Input:* files with extension `.pdf`, `.txt` or `.md` anywhere under `STORIES_DIR` (any folder depth; hidden files and folders are skipped). PDFs have repeated page headers/footers stripped: lines that repeat (ignoring a trailing page number) on at least half the pages. Two layouts, which can be mixed:
- **One story per file** (default, when `STORY_HEADER_PATTERN` is unset): the first non-empty line is the title (markdown `#` marks removed) and the rest is the text.
- **Several stories per file:** `STORY_HEADER_PATTERN` is a regular expression matched against each line; a match starts a new story. It needs a named group `(?<title>…)` and may have `(?<id>…)`. Text before the first match is ignored. With `STORY_BODY_START_PATTERN` set, lines after the header up to the first line matching it are appended to the title (wrapped titles) and that line starts the text; unset, the text starts on the line after the header.

A story with a title but no text is skipped with a warning; a file that yields no stories is skipped and its existing rows are left alone. Two stories that would get the same id stop the run.

## 4. Architecture
- **Web page:** static HTML/JS; served by the backend at `GET /` (same origin, so no CORS); calls backend only (no API keys in browser)
- **Backend:** TypeScript + Fastify on Node (thin service: embed, search, fuse, generate); Milvus Node SDK (`@zilliz/milvus2-sdk-node`), OpenAI Node SDK, Elasticsearch JS client
- **Vector DB:** Milvus Standalone in Docker from day one (Milvus Lite is Python-only)
- **Keyword search (v2):** Elasticsearch in Docker
- **Models:** OpenAI embeddings (`/v1/embeddings`); OpenAI chat model for answers via the Chat Completions API (`/v1/chat/completions`), not the Responses API (Claude is a swappable alternative for generation)
- **Secrets and config:** `.env` file, git-ignored: `OPENAI_API_KEY`, `STORIES_DIR`, `CHAT_MODEL`; optional `STORY_HEADER_PATTERN`, `STORY_BODY_START_PATTERN` (§3), `MIN_SCORE` (§7) and `DOCKER_VOLUME_DIRECTORY` (§11). Anything specific to one collection is configuration, never code

## 5. Data Model
Milvus collection `stories`:

| Field | Type | Notes |
|---|---|---|
| chunk_id | VARCHAR(64) (PK) | Stable ID: `story-` + the story id as a slug, e.g. `story-getting-started` (or `…-s2` for sections); shared with Elasticsearch |
| story_id | VARCHAR(32) | Parent story: the pattern's `(?<id>)` if given, otherwise the title as a slug (lowercase letters, digits and hyphens, accents removed, cut to 32 characters) |
| title | VARCHAR | Story title / question |
| text | VARCHAR | Raw chunk text: the story body |
| source_file | VARCHAR | Path of the origin file relative to `STORIES_DIR` |
| embedding | FLOAT_VECTOR(1536) | Fixed at collection creation; embedded from title + blank line + text |
| content_hash | VARCHAR | SHA-256 of the embedded string (title + text); skip re-embedding when unchanged |

Index: FLAT (exact search), metric COSINE. HNSW can be tried later as a learning exercise.

Because ids come from titles, renaming a story's title creates a new id: the old row is removed as stale and the story is re-embedded.

Elasticsearch index `stories` (v2): same `chunk_id`, `story_id`, `title` (boosted), `text`.

## 6. API
- Ingest is a CLI, not an endpoint: `npm run ingest` (flags `--dry-run`, `--rebuild`, `--batch-size N`)
- `GET /search?q=...&k=3` — returns `{query, k, minScore, results: [{chunk_id, story_id, title, snippet, score}]}` (`results` may be empty when `MIN_SCORE` is set; `minScore` is null when unset); `k` defaults to 3 (1–10), `q` is 1–500 characters; the full text and the embedding stay server-side
- `POST /ask` `{question, k}` — same limits; returns `{answer, model, found, truncated, cited, invalidCitations, sources, usage, noMatches, minScore}`: `found` is false for "Not found in the collection.", `cited` are story IDs the answer cites that were retrieved, `invalidCitations` are cited IDs that were not retrieved (should be empty), `sources` are all retrieved chunks with scores, `noMatches` is true when nothing scored above `MIN_SCORE` (no chat call; `usage` is 0)
- `GET /` — the web page; `GET /health` — liveness check
- `GET /search/hybrid?q=...` (v2) — RRF over Milvus + Elasticsearch

## 7. Success Criteria
- Evaluation set of ~10 questions phrased differently from the stories, each with an expected story
- Search: expected story in top 3 for at least 8 of 10
- Ask: answers cite the correct story and don't invent facts outside the context
- v2: hybrid beats or matches vector-only on the same set, and wins on exact-term queries (e.g. product names)

*Eval set:* `questions.json` lives in `STORIES_DIR` (not the repo); it has `questions` (`id`, `question`, `expected_story_id`, `tests`) and `negative_cases` the stories cannot answer. `npm run eval` checks search; `npm run eval -- --ask` checks answers (cites the expected story; negative cases answer "not found"; no invalid citations) and makes paid chat calls.

*Results (milestones 3–4, `gpt-5.4-mini`, first test set):* search 10/10 in the top 3 (9 ranked first); ask 10/10 cite the expected story, 1/1 negative case answered "not found", 0 invalid citations. Factual faithfulness of the answer text is not automated; it was spot-checked by hand.

*Score threshold (`MIN_SCORE`, optional):* cosine scores with `text-embedding-3-small` are low and depend on the content, so the cutoff is configuration, unset by default, and found by measurement. On the first test set, correct top-1 matches scored 0.25–0.60 and clearly unrelated queries 0.01–0.16, so 0.2 separates them. It cannot catch a plausible-sounding question the stories do not answer: the eval's negative case scores 0.36, above the weakest correct match, so the chat model handles those. `npm run eval` prints the gap (weakest correct match vs. strongest negative case) so the value can be recalibrated for any collection.

## 8. Cost Guardrails
Expected spend is tiny (embedding the 17 first-test-set stories took 14,584 tokens, about $0.0003; each RAG question costs about $0.0035 on `gpt-5.4-mini`, roughly $0.001 on `gpt-5.4-nano`), but usage stays visible and capped.

- **Dedicated OpenAI project:** separate project and API key for this app, with a monthly budget limit set in the dashboard
- **Restricted key:** the key can call only Chat Completions and Embeddings; rotate it when it expires (see SETUP.md)
- **Log usage:** record the `usage` token counts from every embedding and chat response (per request + running total for the process)
- **Pre-count tokens:** embeddings reject an input over 8,191 tokens, a request over 100,000, or a run over 500,000 (`cl100k_base`); chat estimates the prompt (`o200k_base`) and rejects over 12,000
- **Cap output:** `max_completion_tokens` = 1000 on chat calls (newer models reject `max_tokens`); `reasoning_effort: none` is sent to reasoning models so hidden reasoning tokens don't add cost
- **No automatic retries:** OpenAI clients use `maxRetries: 0`, so a failure can't silently repeat a paid call
- **Limit context:** default k = 3 stories per question
- **Skip pointless chat calls:** with `MIN_SCORE` set, a question that matches nothing never reaches the chat model
- **No needless re-embedding:** store a `content_hash` per chunk; ingest re-embeds only new or changed stories

## 9. Milestones
1. Monorepo setup, environment, Milvus Standalone in Docker — **done**
2. Ingest + embed + store — **done**
3. Search endpoint + eval script — **done**
4. Ask endpoint (RAG) — **done**
5. Web page — **done**
6. Elasticsearch indexing
7. Hybrid search with RRF + compare results

*Between milestones 5 and 6 the code was made content-agnostic (document layout and ids moved from code to configuration; see §3, §5, §11).*

## 10. Repo Layout (monorepo)
```
story-search/              # monorepo (npm workspaces)
  README.md                # overview, quick start, commands, API summary
  spec.md
  SETUP.md                 # one-time prework: Docker, Milvus, .env, OpenAI key, story folder
  CLAUDE.md                # working rules for Claude Code
  package.json             # workspaces: packages/*; scripts: dev:up, dev:down, check:milvus, ingest, ingest:dry, api, eval
  tsconfig.base.json
  .env.example             # OPENAI_API_KEY, STORIES_DIR, CHAT_MODEL, DOCKER_VOLUME_DIRECTORY, STORY_HEADER_PATTERN, STORY_BODY_START_PATTERN, MIN_SCORE
  .gitignore               # .env, volumes/ (Milvus data), node_modules/
  docker-compose.yml       # Milvus Standalone, Elasticsearch (later)
  scripts/
    dev-up.sh              # start Docker Desktop + Milvus, wait until healthy
    dev-down.sh            # stop Milvus, quit Docker Desktop (data kept)
  packages/
    api/                   # Fastify backend (run with tsx, no build step)
      src/env.ts           # loads the root .env by explicit path
      src/checkMilvus.ts   # connects to Milvus and prints the server version
      src/source.ts        # finds .pdf/.txt/.md files under STORIES_DIR and reads them as lines
      src/pdf.ts           # PDF -> text lines, footers stripped
      src/chunk.ts         # lines -> one chunk per story (header pattern or one per file), ids, content_hash
      src/embed.ts         # OpenAI embeddings, token guardrails, usage logging
      src/milvus.ts        # collection schema, hash lookup, upsert, stale-row delete
      src/ingest.ts        # ingest CLI
      src/searchMilvus.ts  # vector search
      src/rag.ts           # ask: retrieve -> prompt -> Chat Completions -> citation check
      src/server.ts        # Fastify routes; also serves the web page
      src/searchEs.ts      # v2
      src/fusion.ts        # v2
    web/
      index.html           # single static page, served by the API at GET /
    eval/
      runEval.ts           # search eval (with score-gap report) and --ask eval (direct or http mode)

<private story folder>/    # STORIES_DIR, outside the repo
  *.pdf, *.txt, *.md       # story documents, any folder depth
  questions.json           # eval questions and negative cases
  .story-search/           # generated files, e.g. eval-embeddings.json (query-vector cache)
```
Milvus data lives in `volumes/` under `DOCKER_VOLUME_DIRECTORY` (default: the repo root; see §11).

## 11. Decisions
- OpenAI's current small chat model for answers, set via `CHAT_MODEL` in `.env`; k = 3 by default
- Answers use the Chat Completions API, matching the restricted API key's permissions
- Story docs live outside the code repo in a local private folder (path set via `STORIES_DIR` in `.env`); may become a separate private repo later
- Chat model chosen: `gpt-5.4-mini` (about $0.0035 per question). `gpt-5.4-nano` passed the same eval at about a third of the cost but its docs page marks it deprecated, so it is a one-line `CHAT_MODEL` switch rather than the default
- Milvus data folder is set with `DOCKER_VOLUME_DIRECTORY` and must stay outside iCloud-synced folders such as `~/Documents`; there MinIO fails with `resource deadlock avoided` and writes stall (see SETUP.md §5)
- Eval questions stay in `STORIES_DIR` (not `packages/eval/`), and the eval's query-embedding cache sits in the hidden `STORIES_DIR/.story-search/`, so no story-derived data enters the repo
- The web page is served by the API at `GET /`; its history lives only in the page (cleared on refresh), not in `localStorage`, because answers derive from private stories
- `.env` is loaded with Node's built-in `process.loadEnvFile` (no `dotenv`); root npm scripts call `tsx` directly so CLI flags forward
- The project stays content-agnostic: nothing in code, prompts, UI text or docs is specific to one collection or domain. A document layout (how stories are delimited, how titles wrap) is configuration, not code; story ids are not assumed to have any particular shape and default to a slug of the title
- A minimum similarity score (`MIN_SCORE`) is an optional setting, not a built-in constant, because scores vary with the embedding model and the content. It is set to 0.2 for the first test set; the eval reports the score gap so it can be recalibrated
