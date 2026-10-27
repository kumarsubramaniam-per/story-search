# Story Bank Search — Spec (v0.3)

## 1. Goal
Build a small local application to learn Milvus vector search and retrieval-augmented generation (RAG), using an interview story bank (~20–30 stories / Q&As, ~700 words each) as the test corpus. Later, add Elasticsearch keyword search and fuse both result sets (hybrid search).

## 2. Scope
**In scope (v1)**
- Ingest story bank documents, one chunk per story
- Embed chunks with OpenAI `text-embedding-3-small` (1536 dims)
- Store vectors + text + metadata in Milvus
- Semantic search endpoint (top-k stories)
- Ask endpoint: retrieve top-k, send to LLM, answer grounded only in retrieved context, with cited story IDs
- Minimal web page calling the backend
- Run everything locally on Mac

**Later (v2)**
- Elasticsearch BM25 index over the same chunks
- Hybrid search with Reciprocal Rank Fusion (RRF)
- Optional: compare with Milvus built-in BM25 full-text search
- Optional: section-level chunking (Situation / Actions / Result) if story-level vectors prove too blurry
- Future direction: generalize into a knowledge-base agent over any private document set

**Out of scope**
- Auth, multi-user, cloud deployment
- Real-time document sync

## 3. User Flows
**Search:** user types a query → backend embeds query → Milvus returns top-k chunks → page shows story title, snippet, score.

**Ask:** user types a question → backend retrieves top-k chunks → builds prompt (system instruction: answer only from context, say "not found" otherwise) → LLM returns answer → page shows answer plus source stories.

**Ingest (CLI):** read story files → split into chunks → embed → upsert into Milvus (later also index into Elasticsearch).

*Input format:* a story bank PDF in `STORIES_DIR`. Each story starts with a short code header (e.g. `A1`) followed by its title. Split into one chunk per story at those headers; use the code as `story_id` and the heading as `title`; strip repeated page headers/footers.

## 4. Architecture
- **Web page:** static HTML/JS; calls backend only (no API keys in browser)
- **Backend:** TypeScript + Fastify on Node (thin service: embed, search, fuse, generate); Milvus Node SDK (`@zilliz/milvus2-sdk-node`), OpenAI Node SDK, Elasticsearch JS client
- **Vector DB:** Milvus Standalone in Docker from day one (Milvus Lite is Python-only)
- **Keyword search (v2):** Elasticsearch in Docker
- **Models:** OpenAI embeddings (`/v1/embeddings`); OpenAI chat model for answers via the Chat Completions API (`/v1/chat/completions`), not the Responses API (Claude is a swappable alternative for generation)
- **Secrets:** `.env` file with `OPENAI_API_KEY`, `STORIES_DIR` and `CHAT_MODEL`, git-ignored

## 5. Data Model
Milvus collection `stories`:

| Field | Type | Notes |
|---|---|---|
| chunk_id | VARCHAR (PK) | Stable ID, e.g. `story-07` or `story-07-s2`; shared with Elasticsearch |
| story_id | VARCHAR | Parent story |
| title | VARCHAR | Story title / question |
| text | VARCHAR | Raw chunk text |
| source_file | VARCHAR | Origin document |
| embedding | FLOAT_VECTOR(1536) | Fixed at collection creation |
| content_hash | VARCHAR | Hash of chunk text; skip re-embedding when unchanged |

Index: FLAT (exact search), metric COSINE. HNSW can be tried later as a learning exercise.

Elasticsearch index `stories` (v2): same `chunk_id`, `story_id`, `title` (boosted), `text`.

## 6. API
- `POST /ingest` (or CLI script) — rebuild collection from source files
- `GET /search?q=...&k=3` — returns ranked chunks with scores
- `POST /ask` `{question, k}` — returns answer + source chunk IDs
- `GET /search/hybrid?q=...` (v2) — RRF over Milvus + Elasticsearch

## 7. Success Criteria
- Evaluation set of ~10 questions phrased differently from the stories, each with an expected story
- Search: expected story in top 3 for at least 8 of 10
- Ask: answers cite the correct story and don't invent facts outside the context
- v2: hybrid beats or matches vector-only on the same set, and wins on exact-term queries (e.g. product names)

## 8. Cost Guardrails
Expected spend is tiny (embedding all ~30 stories is well under $0.01; each RAG question costs about $0.001 on a small chat model), but usage stays visible and capped.

- **Dedicated OpenAI project:** separate project and API key for this app, with a monthly budget limit set in the dashboard
- **Restricted key:** the key can call only Chat Completions and Embeddings; rotate it when it expires (see SETUP.md)
- **Log usage:** record the `usage` token counts from every embedding and chat response (per request + running total)
- **Pre-count tokens:** estimate prompt size with a tokenizer before sending; reject prompts over a set ceiling
- **Cap output:** set `max_tokens` on chat calls
- **Limit context:** default k = 3 stories per question
- **No needless re-embedding:** store a `content_hash` per chunk; ingest re-embeds only new or changed stories

## 9. Milestones
1. Monorepo setup, environment, Milvus Standalone running in Docker
2. Ingest + embed + store
3. Search endpoint + eval script
4. Ask endpoint (RAG)
5. Web page
6. Elasticsearch indexing
7. Hybrid search with RRF + compare results

## 10. Repo Layout (monorepo)
```
story-search/              # monorepo (npm/pnpm workspaces)
  README.md
  spec.md
  SETUP.md                 # one-time prework: Docker, Milvus, .env, OpenAI key, story folder
  CLAUDE.md                # working rules for Claude Code
  package.json             # workspaces: packages/*
  tsconfig.base.json
  .env.example             # OPENAI_API_KEY, STORIES_DIR, CHAT_MODEL
  .gitignore               # .env, volumes/ (Milvus data), node_modules/
  docker-compose.yml       # Milvus Standalone, Elasticsearch (later)
  scripts/
    dev-up.sh              # start Docker Desktop + Milvus, wait until healthy
    dev-down.sh            # stop Milvus, quit Docker Desktop (data kept)
  packages/
    api/                   # Fastify backend
      src/server.ts
      src/ingest.ts
      src/embed.ts
      src/searchMilvus.ts
      src/searchEs.ts      # v2
      src/fusion.ts        # v2
      src/rag.ts
    web/                   # static page
      index.html
    eval/
      questions.json
      runEval.ts

<private story folder>/    # story docs, outside the repo (STORIES_DIR)
```

## 11. Decisions
- OpenAI's current small chat model for answers, set via `CHAT_MODEL` in `.env`; k = 3 by default
- Answers use the Chat Completions API, matching the restricted API key's permissions
- Story docs live outside the code repo in a local private folder (path set via `STORIES_DIR` in `.env`); may become a separate private repo later
