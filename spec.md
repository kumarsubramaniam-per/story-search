# Story Search — Spec (v1.5)

*Status: milestones 1–9 are built (see §9). §§3–8 and 10 describe what is built.*

## 1. Goal
Build a small local application to learn Milvus vector search and retrieval-augmented generation (RAG) over a private collection of short documents. The project is content-agnostic: a **story** is any self-contained piece of content small enough to embed as one chunk (an article, note, FAQ entry, Q&A, case study…). The first test set is ~20–30 stories of ~700 words each. Later, add Elasticsearch keyword search and fuse both result sets (hybrid search).

## 2. Scope
**In scope (v1)**
- Ingest story documents (`.pdf`, `.txt`, `.md`) in one file or many, one chunk per story; a file holds one story or several
- Embed chunks with OpenAI `text-embedding-3-small` (1536 dims)
- Store vectors + text + metadata in Milvus
- Semantic search endpoint (top-k stories)
- Optional Elasticsearch BM25 keyword index over the same chunks; the search method (vector, keyword, hybrid) is chosen per request; hybrid fuses the two rankings with reciprocal rank fusion (RRF)
- Ask endpoint: retrieve top-k, send to LLM, answer grounded only in retrieved context, with cited story IDs
- Minimal web page calling the backend (Search/Ask toggle, search-method control, in-page history)
- An activity log: one JSON line per request, with timings and token counts, in a git-ignored file (no query or story text)
- Unit tests (vitest) for the logic, offline and free: external services are mocked (§11)
- Run everything locally on Mac

**Later (optional)**
- Optional: compare with Milvus built-in BM25 full-text search
- Optional: section-level chunking if story-level vectors prove too blurry
- Future direction: generalize into a knowledge-base agent over any private document set

**Out of scope**
- Auth, multi-user, cloud deployment
- Real-time document sync

## 3. User Flows
**Search:** user types a query and picks a search method (`mode`):
- **vector:** backend embeds the query → Milvus returns the top-k chunks by meaning. Hits scoring below `MIN_SCORE` (if set) are dropped, so an unrelated query can return nothing ("No close matches").
- **keyword:** Elasticsearch BM25 over title and text (a title match counts 3×); no embedding call. Needs `ELASTICSEARCH_URL`.
- **hybrid:** the vector and keyword searches run at the same time, each returning a pool of candidates (at least 20, or 3× k). Their two rankings are merged by reciprocal rank fusion: a story earns `1 / (60 + rank)` from every list it appears in, the earnings are added, and the top k are kept. Only ranks are used, so cosine and BM25 scores need not be comparable, and the merge is plain code, not an LLM. A story liked by both methods rises above one ranked first by only one. `MIN_SCORE` trims the vector list before fusing; the keyword list has no threshold. The page shows each story's rank in each list ("vector #2 · keyword #1"). It costs the same as vector search: one embedding call.

The page shows story title, snippet and score, labelled by method (cosine similarity is 0–1; BM25 has no upper limit, so the two scores are not comparable). If `mode` is omitted, `SEARCH_MODE` applies (default `vector`).

**Ask:** user types a question → backend retrieves top-k chunks (by the chosen method) → builds prompt (system instruction: answer only from context, cite story IDs like `[id]`, write plain text, and reply exactly "Not found in the collection." otherwise) → LLM returns answer → page shows answer plus source stories (cited ones marked). The citations are checked against the retrieved set. If retrieval finds no story (all vector hits below `MIN_SCORE`, or no keyword match), the chat call is skipped and the reply is "Not found in the collection." with `noMatches: true`.

**Ingest (CLI):** read story files → split into chunks → with `ELASTICSEARCH_URL` set, first check Elasticsearch is reachable (before any paid call) and index every chunk of the file into it (free and idempotent, so no hash check) and remove documents for stories no longer in that file → then, for each batch: look up stored `content_hash`es, embed only new/changed chunks, upsert into Milvus → delete Milvus rows for stories no longer in that source file.

*Input:* files with extension `.pdf`, `.txt` or `.md` anywhere under `STORIES_DIR` (any folder depth; hidden files and folders are skipped). PDFs have repeated page headers/footers stripped: lines that repeat (ignoring a trailing page number) on at least half the pages. Two layouts, which can be mixed:
- **One story per file** (default, when `STORY_HEADER_PATTERN` is unset): the first non-empty line is the title (markdown `#` marks removed) and the rest is the text.
- **Several stories per file:** `STORY_HEADER_PATTERN` is a regular expression matched against each line; a match starts a new story. It needs a named group `(?<title>…)` and may have `(?<id>…)`. Text before the first match is ignored. With `STORY_BODY_START_PATTERN` set, lines after the header up to the first line matching it are appended to the title (wrapped titles) and that line starts the text; unset, the text starts on the line after the header.

A story with a title but no text is skipped with a warning; a file that yields no stories is skipped and its existing rows are left alone. Two stories that would get the same id stop the run.

## 4. Architecture
- **Web page:** static HTML/JS; served by the backend at `GET /` (same origin, so no CORS); calls backend only (no API keys in browser)
- **Backend:** TypeScript + Fastify on Node (thin service: embed, search, fuse, generate); Milvus Node SDK (`@zilliz/milvus2-sdk-node`), OpenAI Node SDK, Elasticsearch JS client
- **Vector DB:** Milvus Standalone in Docker from day one (Milvus Lite is Python-only)
- **Keyword search:** Elasticsearch 9.4.8 in Docker (client `@elastic/elasticsearch` 9.4.x), single node, security off, port bound to `127.0.0.1`; optional, enabled by `ELASTICSEARCH_URL`
- **Models:** OpenAI embeddings (`/v1/embeddings`); OpenAI chat model for answers via the Chat Completions API (`/v1/chat/completions`), not the Responses API (Claude is a swappable alternative for generation)
- **Secrets and config:** `.env` file, git-ignored: `OPENAI_API_KEY`, `STORIES_DIR`, `CHAT_MODEL`; optional `STORY_HEADER_PATTERN`, `STORY_BODY_START_PATTERN` (§3), `MIN_SCORE` (§7), `ELASTICSEARCH_URL`, `ELASTICSEARCH_ANALYZER` and `SEARCH_MODE` (§5, §6) and `DOCKER_VOLUME_DIRECTORY` (§11). Anything specific to one collection is configuration, never code

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

Elasticsearch index `stories` (when `ELASTICSEARCH_URL` is set): one document per chunk, with `chunk_id` as the document id. Fields: `chunk_id`, `story_id`, `source_file`, `content_hash` (keywords) and `title`, `text` (analyzed text). One shard, no replicas (single local node). The analyzer is `ELASTICSEARCH_ANALYZER`, default `english` (stems words and drops common ones; use another built-in analyzer name for other languages); if it changes, ingest recreates the index, which costs nothing because no embeddings are involved. The title is boosted 3× at query time. Fuzzy (typo) matching is not enabled.

## 6. API
- Ingest is a CLI, not an endpoint: `npm run ingest` (flags `--dry-run`, `--rebuild`, `--batch-size N`)
- `GET /search?q=...&k=3&mode=vector|keyword|hybrid` — returns `{query, k, mode, minScore, results: [{chunk_id, story_id, title, snippet, score}]}`; `mode` defaults to `SEARCH_MODE` (default `vector`); `results` may be empty (vector: below `MIN_SCORE`; keyword: no match; hybrid: neither search found anything); in hybrid mode `score` is the RRF sum and each result has `ranks` (its rank in each list it appeared in); `minScore` applies to vector mode and to the vector side of hybrid, and is null for keyword or when unset; `k` defaults to 3 (1–10), `q` is 1–500 characters; the full text and the embedding stay server-side
- `POST /ask` `{question, k, mode}` — same limits; returns `{answer, model, mode, found, truncated, cited, invalidCitations, sources, usage, noMatches, minScore}`: `found` is false for "Not found in the collection.", `cited` are story IDs the answer cites that were retrieved, `invalidCitations` are cited IDs that were not retrieved (should be empty; retrieved ids are found inside each `[...]` wherever they sit between spaces, commas or semicolons; leftover single words are reported, bracketed prose with spaces is ignored), `sources` are all retrieved chunks with scores, `noMatches` is true when retrieval found nothing (no chat call; `usage` is 0)
- Mode errors: an unknown `mode` is a 400; `keyword` or `hybrid` without `ELASTICSEARCH_URL` is a 400 naming the setting. The server refuses to start if `SEARCH_MODE` is invalid or not available
- `GET /` — the web page; `GET /health` — `{ok, modes: {vector, keyword, hybrid}, defaultMode}`, which the page uses to disable methods that aren't set up
- Hybrid search is `mode=hybrid` on the same endpoints (RRF over Milvus + Elasticsearch), not a separate route

## 7. Success Criteria
- Evaluation set of ~10 questions phrased differently from the stories, each with an expected story
- Search: expected story in top 3 for at least 8 of 10
- Ask: answers cite the correct story and don't invent facts outside the context
- Hybrid: beats or matches vector-only on the same set, and wins on exact-term queries (e.g. product names)

*Eval set:* `questions.json` lives in `STORIES_DIR` (not the repo); it has `questions` (`id`, `question`, `expected_story_id`, `tests`) and `negative_cases` the stories cannot answer. `npm run eval` checks search; `npm run eval -- --ask` checks answers (cites the expected story; negative cases answer "not found"; no invalid citations) and makes paid chat calls. `--mode vector|keyword` picks the search method (default `vector`) and `--via direct|http` picks how it runs (in-process, or against a running server).

*Results (milestones 3–4, `gpt-5.4-mini`, first test set):* search 10/10 in the top 3 (9 ranked first); ask 10/10 cite the expected story, 1/1 negative case answered "not found", 0 invalid citations. The ask eval was re-run after the content-agnostic prompt and `MIN_SCORE=0.2` with the same result (about 29,900 prompt and 1,560 completion tokens, roughly $0.029 for the 11 calls). Factual faithfulness of the answer text is not automated; it was spot-checked by hand.

*Keyword baseline (milestone 6, `english` analyzer, first test set):* 10/10 in the top 3 (8 ranked first), no OpenAI calls. The two methods differ most on the exact-term acronym question: keyword puts the right story at 3.58 against 0.76 for the runner-up, while vector scores it 0.25 against 0.22. Keyword scores are BM25 values, not comparable with cosine scores, so `MIN_SCORE` applies to vector results only (vector mode, and the vector side of hybrid). A keyword ask was spot-checked (cited the right story, no embedding call).

*Hybrid comparison (milestone 7, first test set):* `npm run eval -- --compare` ranks the expected story in each method (depth 10, no OpenAI cost):

| | vector | keyword | hybrid |
|---|---|---|---|
| in the top 3 | 10/10 | 10/10 | 10/10 |
| ranked first | 9/10 | 8/10 | 9/10 |
| MRR@10 | 0.950 | 0.883 | 0.950 |

Hybrid matches vector-only and beats keyword-only, so the first criterion holds, but it does not beat vector overall. Fusion fixed one question (q01: 2nd in both lists, 1st fused) and cost another (q07: 1st by vector but 3rd by keyword, so a story ranked 1st and 4th lost narrowly, 0.0325 to 0.0323). It also did not "win" on the exact-term acronym question: all three methods rank the right story first there, so rank alone cannot show keyword's much larger score margin (3.58 vs 0.76 against vector's 0.25 vs 0.22). Ten questions with one exact-term case is too small to show that criterion; more exact-term questions in `questions.json` would. The candidate pool made no difference (`--pool` 10, 20 and 100 give identical results) because a 17-story collection fits inside every pool; it would matter on a larger one. A keyword search has no score threshold, so incidental words can produce weak keyword-only hits that hybrid passes through (an unrelated query matched two stories at BM25 about 1.9, against 16 for a real hit); the chat model still answers "not found" for those in Ask.

*Score threshold (`MIN_SCORE`, optional):* cosine scores with `text-embedding-3-small` are low and depend on the content, so the cutoff is configuration, unset by default, and found by measurement. On the first test set, correct top-1 matches scored 0.25–0.60 and clearly unrelated queries 0.01–0.16, so 0.2 separates them (the search eval is unchanged at 0.2: 10/10 in the top 3, 9 ranked first). It cannot catch a plausible-sounding question the stories do not answer: the eval's negative case scores 0.36, above the weakest correct match, so the chat model handles those. `npm run eval` prints the gap (weakest correct match vs. strongest negative case) so the value can be recalibrated for any collection.

## 8. Cost Guardrails
Expected spend is tiny (embedding the 17 first-test-set stories took 14,584 tokens, about $0.0003; each RAG question costs about $0.0035 on `gpt-5.4-mini`, roughly $0.001 on `gpt-5.4-nano`), but usage stays visible and capped.

- **Dedicated OpenAI project:** separate project and API key for this app, with a monthly budget limit set in the dashboard
- **Restricted key:** the key can call only Chat Completions and Embeddings; rotate it when it expires (see SETUP.md)
- **Log usage:** record the `usage` token counts from every embedding and chat response (per request + running total for the process)
- **Pre-count tokens:** embeddings reject an input over 8,191 tokens, a request over 100,000, or a run over 500,000 (`cl100k_base`); chat estimates the prompt (`o200k_base`) and rejects over 12,000
- **Cap output:** `max_completion_tokens` = 1000 on chat calls (newer models reject `max_tokens`); `reasoning_effort: none` is sent to reasoning models so hidden reasoning tokens don't add cost
- **No automatic retries:** OpenAI clients use `maxRetries: 0`, so a failure can't silently repeat a paid call
- **Limit context:** default k = 3 stories per question
- **Skip pointless chat calls:** a question that retrieves nothing (below `MIN_SCORE`, or no keyword match) never reaches the chat model
- **Keyword work is free:** Elasticsearch indexing and keyword search make no OpenAI calls, and ingest checks Elasticsearch is reachable before any paid embedding call
- **Hybrid costs the same as vector:** one embedding call; the fusion is plain code, and only the final top k reach the prompt
- **No needless re-embedding:** store a `content_hash` per chunk; ingest re-embeds only new or changed stories

**Activity log.** The app appends one JSON object per line to `logs/activity.log` at the repo root (git-ignored; `LOG_FILE` in `.env` overrides the path). At about 5 MB the file is renamed to `activity.log.1`, replacing an older one, so the log stays under about 10 MB. A write failure is reported once on the terminal and never fails a request. Events:
- `request`, written when a response finishes, for every route including `/health`, validation failures and unknown routes: `id`, `route` (the route pattern, never the URL), `status`, `ms`, and `stages` (milliseconds in `embed`, `vector`, `keyword`, `fuse`, `chat`, whichever ran). `/search` adds `mode`, `k`, `query_chars`, `results`; `/ask` adds `question_chars`, `results`, `no_matches`, `found`, `truncated`, `cited`, `invalid_citations`, `model`, `prompt_tokens`, `completion_tokens`; a request that embedded also gets `embedding_tokens`; a failure adds `error {name, message}`
- `server_start` (available modes, default mode, whether `MIN_SCORE` is set, chat model) and `server_stop`
- `ingest`, one per run, dry runs included: `dry_run`, `rebuild`, `files`, `stories`, `embedded`, `skipped`, `stale_deleted`, `es_indexed`, `es_stale_removed`, `embedding_tokens`, `ms`, and on failure `error` (the error name only)

The log holds no query text, question text, story text, snippets, titles or answers: only lengths, counts, numbers and timings. Error messages have the request's own query or question text scrubbed out before they are written, and are cut to 200 characters. Tokens are logged, not dollars, because prices change; cost is tokens times the current price.

## 9. Milestones
1. Monorepo setup, environment, Milvus Standalone in Docker — **done**
2. Ingest + embed + store — **done**
3. Search endpoint + eval script — **done**
4. Ask endpoint (RAG) — **done**
5. Web page — **done**
6. Elasticsearch indexing — **done** (keyword mode, mode parameter, page method control)
7. Hybrid search with RRF + compare results — **done** (`mode=hybrid`, per-method ranks on the page, `--compare` eval)
8. Observability: activity log — **done** (per-request JSON lines with stage timings and token counts, server and ingest events, see §8)

9. Unit tests — **done** (vitest; `npm test`; offline; see §11 for what is and is not covered)
*Between milestones 5 and 6 the code was made content-agnostic (document layout and ids moved from code to configuration; see §3, §5, §11).*

## 10. Repo Layout (monorepo)
```
story-search/              # monorepo (npm workspaces)
  README.md                # overview, quick start, commands, API summary
  spec.md
  SETUP.md                 # one-time prework: Docker, Milvus, .env, OpenAI key, story folder
  CLAUDE.md                # working rules for Claude Code
  package.json             # workspaces: packages/*; scripts: dev:up, dev:down, check:milvus, ingest, ingest:dry, api, eval, test, test:watch
  tsconfig.base.json
  vitest.config.ts         # test runner config: packages/**/*.test.ts
  test/setup.ts            # test setup: stubs env.ts, redirects the activity log to a temp file, clears config env between tests
  .env.example             # OPENAI_API_KEY, STORIES_DIR, CHAT_MODEL, DOCKER_VOLUME_DIRECTORY, STORY_HEADER_PATTERN, STORY_BODY_START_PATTERN, MIN_SCORE, ELASTICSEARCH_URL, ELASTICSEARCH_ANALYZER, SEARCH_MODE, LOG_FILE
  .gitignore               # .env, volumes/ (Milvus data), node_modules/, logs/
  logs/                    # activity.log (and activity.log.1), git-ignored; created on first write
  .github/workflows/       # claude.yml (@claude mentions) and claude-code-review.yml (PR review, with a pass/fail gate on its findings)
  docker-compose.yml       # Milvus Standalone (etcd, minio, standalone) and Elasticsearch
  scripts/
    dev-up.sh              # start Docker Desktop + Milvus + Elasticsearch, wait until healthy
    dev-down.sh            # stop the containers, quit Docker Desktop (data kept)
  docs/
    sdd-journey.md         # the author's own build story, for publishing (Claude Code leaves it alone unless asked)
    screenshot.png         # README screenshot of the web page, rendered with made-up sample stories
  packages/
    api/                   # Fastify backend (run with tsx, no build step)
      src/env.ts           # loads the root .env by explicit path
      src/activity.ts      # activity log: JSON-lines writer with rotation, per-request store, stage timers
      src/checkMilvus.ts   # connects to Milvus and prints the server version
      src/source.ts        # finds .pdf/.txt/.md files under STORIES_DIR and reads them as lines
      src/pdf.ts           # PDF -> text lines, footers stripped
      src/chunk.ts         # lines -> one chunk per story (header pattern or one per file), ids, content_hash
      src/embed.ts         # OpenAI embeddings, token guardrails, usage logging
      src/milvus.ts        # collection schema, hash lookup, upsert, stale-row delete
      src/ingest.ts        # ingest CLI
      src/searchMilvus.ts  # vector search (MIN_SCORE)
      src/searchEs.ts      # Elasticsearch: index, bulk indexing, stale delete, keyword (BM25) search
      src/search.ts        # search modes: vector, keyword or hybrid (runs both, then fuses), candidate pool, mode errors
      src/rag.ts           # ask: retrieve (by mode) -> prompt -> Chat Completions -> citation check
      src/app.ts           # buildApp(): Fastify routes, hooks and activity logging, without listening (so tests can inject requests)
      src/server.ts        # starts the app on 127.0.0.1:3000, logs start/stop, closes on SIGINT/SIGTERM
      src/*.test.ts        # vitest unit tests, one per module, next to the code
      src/fusion.ts        # reciprocal rank fusion (RRF)
    web/
      index.html           # single static page, served by the API at GET /
    eval/
      runEval.ts           # search eval (score-gap report), --ask eval, --compare table; --mode vector|keyword|hybrid, --pool N, --via direct|http

<private story folder>/    # STORIES_DIR, outside the repo
  *.pdf, *.txt, *.md       # story documents, any folder depth
  questions.json           # eval questions and negative cases
  .story-search/           # generated files, e.g. eval-embeddings.json (query-vector cache)
```
Milvus and Elasticsearch data live in `volumes/` under `DOCKER_VOLUME_DIRECTORY` (default: the repo root; see §11).

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
- A minimum similarity score (`MIN_SCORE`) is an optional setting, not a built-in constant, because scores vary with the embedding model and the content. It is set to 0.2 for the first test set; the eval reports the score gap so it can be recalibrated. It applies to vector results only, since BM25 scores are on a different scale
- Elasticsearch 9.4.8 (the last patch of the 9.4 line, with the 9.4.x client) for keyword search. It is local-only: security is off, so its port is bound to `127.0.0.1`; its data folder is under `DOCKER_VOLUME_DIRECTORY` and must also stay outside iCloud, because it relies on file locks
- Elasticsearch is optional (`ELASTICSEARCH_URL`). When set, ingest indexes every chunk on every run instead of comparing hashes, because indexing is free and this fills a newly started Elasticsearch without re-embedding; if it is set but unreachable, ingest stops before any paid call
- Keyword analyzer: `english` by default, as a setting (`ELASTICSEARCH_ANALYZER`) because the project is content-agnostic; a change recreates only the Elasticsearch index. Fuzzy matching was left out: vector search already tolerates typos, and it adds noise on short exact terms
- One `/search` and `/ask` with a `mode` parameter (vector, keyword, hybrid) replaces the separate `/search/hybrid` route planned in §6 v0.7; `SEARCH_MODE` sets the default. In the eval, `--mode` is the search method and `--via` is how it runs
- Hybrid fusion: reciprocal rank fusion with the standard constant 60, fixed in code rather than a setting, because it needs no tuning and the project has no data to tune it on. Each search contributes a candidate pool of at least 20, or 3× k, so a story ranked 4th by both methods can still win, while weak agreement deep in both lists does not outweigh one method's strong match (RRF is gentle with depth: rank 1 earns 0.0164, rank 20 earns 0.0125). The eval's `--pool` flag lets the effect be measured
- In hybrid mode `MIN_SCORE` trims only the vector candidates before fusing, so an unrelated query is not lifted by a weak vector hit. The keyword list has no threshold (BM25 scores depend on the corpus), so weak keyword-only hits can pass through; a keyword score cutoff was left out until it is shown to be needed
- Observability is a local activity log, not a monitoring stack: structured JSON lines in `logs/activity.log` inside the repo (git-ignored), written with Node's built-in `fs`, with stage timings carried through each request by `AsyncLocalStorage` so the search, embedding and chat code need no extra arguments. Query and question text are never logged, only their lengths, and error messages are scrubbed of them; tokens are logged but not dollars. The server now closes on Ctrl-C or a kill (SIGINT/SIGTERM) so the stop is logged. OpenTelemetry, metrics servers and dashboards were left out as too heavy for one local process
- The page shows each hybrid result's rank in each list (for example "vector #2 · keyword #1") so a learner can see why a story landed where it did, and `npm run eval -- --compare` prints the three methods' ranks side by side, with top-3 counts, first-place counts and MRR@10
- Unit tests use vitest (approved dependency). They are offline and free: OpenAI, Milvus and Elasticsearch are mocked, fixtures are made-up neutral text, and the activity log is redirected to a temp file. New or changed logic ships with tests in the same PR (CLAUDE.md, "Testing"). They cover what the code decides (fusion, chunking, ids and hashes, guardrails, validation, routes, log contents), not whether Milvus, Elasticsearch or OpenAI behave as expected; that stays with the eval and manual runs against the real services. Not unit-tested: PDF extraction (needs real PDF fixtures), `env.ts`, the Milvus/Elasticsearch collection and index setup, `checkMilvus.ts`, `server.ts` (a few lines of listen and signals) and `runEval.ts`
- `server.ts` was split in two so routes can be tested without opening a port: `app.ts` exports `buildApp()` (all routes, hooks and logging; same behaviour), `server.ts` only listens and handles signals
- Citations are found by looking for the retrieved ids themselves inside each bracket group (longest first, delimited by spaces, commas or semicolons), so ids of any shape, including ones with spaces or commas, are credited and `[id1 id2]` works. Whatever is left in the group is split on commas and semicolons: an item with no spaces that contains a letter or digit is reported in `invalidCitations`, anything else (words with spaces, punctuation) is ignored. No id shape is assumed. Known limits, accepted because `invalidCitations` is only a diagnostic and the system prompt asks for plain text: a leftover single word cannot be told from a made-up id, so `[sic]`, `[1]` or comma-separated prose such as `[Smith, 2020]` is still reported; a short retrieved id standing alone between spaces in bracketed prose is credited (and the other words reported); ids that contain `[` or `]` are not supported. Making citations unambiguous (for example a `[[id]]` format asked for in the prompt) was left out because it needs a prompt change and a paid re-run of the ask eval
- Pull requests get an automated review (`claude-code-review.yml`) and `main` is protected by a ruleset (PR required, merge commits only, `claude-review` must pass; the repo owner can bypass). The review step succeeds whatever it finds, so a final gate step makes the job fail on inline findings, on any bot comment that is not "No issues found", and on silence, because silence cannot be told from "did not review". Only comments created during the current run count, so an older push's comment cannot decide the result. The gate reads comment text and the bot's login, so it depends on the review plugin's output format; if that changes, the gate fails closed and the owner bypasses until it is updated. The same applies to any pull request that changes a workflow file: the review action refuses to run on a workflow that differs from the one on `main` (it skips itself and the step still reports success), so no comment appears, the gate fails on silence, and the check is red until the owner bypasses. Such a change cannot be verified by its own run, so it is checked after merging, on a later pull request. The workflow's reviewer reported nothing on two PRs where a local review found several issues, so it is a backstop, not a replacement for running `/code-review` locally first
