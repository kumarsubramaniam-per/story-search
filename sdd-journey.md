# How I built story-search with spec-driven development

I wanted to learn vector search and RAG by building something real, not by reading about it. So I set myself a project: semantic search and grounded Q&A over a private set of documents, running entirely on my Mac, with Milvus as the vector database and OpenAI for embeddings and answers. Along the way I tried a way of working I'd been curious about, spec-driven development, with Claude Code writing most of the code while I owned the decisions, the spec and the review.

This is the story of how that went, all seven milestones, including the parts that went wrong.

## Why this project
I wanted hands-on time with Milvus and with the full RAG loop: chunk, embed, store, search, then ask a model to answer only from what was retrieved. The goal is a knowledge-base agent with hybrid search (vector plus keyword), but I decided to add one new system at a time. So I started with Milvus and RAG, and added Elasticsearch and hybrid search once that worked (milestones 6 and 7).

## The approach: spec first, code second
Spec-driven development, for me, meant working in a fixed order: **understand, specify, set up, plan, build, verify**, one milestone at a time.

| Phase | What I did | What it produced |
|---|---|---|
| 1. Learn the concepts | Asked questions before deciding anything: chunking, embeddings, the RAG flow, HNSW vs FLAT indexes, hybrid search and reciprocal rank fusion, Fastify vs Express, costs | A mental model of the moving parts |
| 2. Write the spec | Goal, scope (first version, later, out), user flows, architecture, data model, API, success criteria, cost guardrails, milestones, repo layout and decisions. I iterated from v0.1 to v0.3 and turned every open question into a recorded decision | `spec.md` |
| 3. Define "done" before code | Wrote about 10 evaluation questions, worded differently from the source documents, each with an expected answer. I added tricky near-neighbours, an exact-term query and a question the documents can't answer | `questions.json`, kept out of git |
| 4. Do the prework by hand | Docker, Milvus Standalone, an OpenAI project with a restricted key and a budget, `.env`, and a private data folder. I wrote down every step as I went | `SETUP.md`, `scripts/dev-up.sh`, `scripts/dev-down.sh` |
| 5. Set rules for the AI | One milestone at a time, a plan before any code, ask before installing anything, protected files, how to handle secrets, the stack conventions | `CLAUDE.md` |
| 6. Baseline in git | Committed and pushed the prework to a private repo before any AI-written code existed, so every milestone is a clean diff | A readable history |
| 7. Build milestone by milestone | Claude Code proposes a plan, I review it, it builds, I review the diff, it verifies, and only then do I say commit, and separately push | Milestones 1 to 7 in the spec, all built |

## Building it, one milestone at a time
Every milestone followed the same loop. Claude proposed a short plan and the questions I needed to answer. I approved or changed it. It built, then verified with real runs. Only after that did I say "commit", and, as a separate step, "push".

| # | What got built | How it was verified |
|---|---|---|
| 1 | An npm-workspaces monorepo, a shared tsconfig, the root `.env` loaded by explicit path, `dev:up` and `dev:down` scripts, and a script that prints the Milvus server version | Ran it from the repo root and from inside the package; type-check |
| 2 | Ingest: PDF to one chunk per story, then an OpenAI embedding, then Milvus (FLAT index, cosine metric) | A dry run listed every story; a second run embedded nothing (content-hash skip); I checked the row count, schema and index |
| 3 | A Fastify `GET /search` and an eval script that runs in-process or over HTTP | The expected story was in the top 3 for 10 of 10 questions, ranked first for 9 |
| 4 | `POST /ask`: retrieve the top 3 stories, answer only from them with cited story ids, and say "not found" otherwise | 10 of 10 answers cite the right story, the unanswerable question is handled, and no answer cites a story that wasn't retrieved |
| 5 | One static page served by the same Fastify server: a Search/Ask toggle, results as cards, and a history kept in the page | Checked headlessly first, then I used it in the browser |
| 6 | Elasticsearch 9.4.8 as a second container (the one Compose edit I approved explicitly), and keyword search with BM25 where the title counts three times as much as the body. Ingest indexes every story into Elasticsearch without re-embedding anything. Search and ask take a `mode` on the same endpoints, and everything still works with Elasticsearch switched off | Elasticsearch held the same story ids as Milvus; keyword search made no OpenAI call; 10 of 10 expected stories in the top 3 |
| 7 | Hybrid search: vector and keyword run in parallel, and reciprocal rank fusion (RRF) merges the two ranked lists in plain code, with no LLM involved. Each side contributes a candidate pool of max(20, 3k). The eval gained `--compare`, which prints all three methods side by side | Same eval, zero OpenAI cost thanks to cached query vectors: all three methods 10 of 10 in the top 3; MRR@10 hybrid 0.950, vector 0.950, keyword 0.883 |

### Detours that weren't in the original plan
These came from questions I asked while reviewing, not from the first spec:
- **Hardened ingest.** I asked what would happen with a huge volume of documents. The answer was to embed and save one batch at a time, look up stored hashes per batch, and delete rows for stories that disappeared from a file.
- **Compared two chat models** on the same eval before committing to one.
- **Made the whole project content-agnostic**, so it works for any kind of document, not just my first test set.
- **Added an optional minimum score,** so unrelated queries return nothing and don't cost a chat call.
- **Added two standing rules to `CLAUDE.md`:** keep `spec.md` current after every milestone, and keep the code free of anything specific to one dataset.
- **Made the web controls explain themselves.** The Search/Ask and Vector/Keyword/Hybrid options sat in one row with no separation, so I asked for outlined boxes and a line of sub-text under the chosen option saying what it will do. I also caught that "No OpenAI call" under Keyword would mislead when Ask is selected, because Ask with keyword search still calls the model for the answer.
- **Added a screenshot to the README,** drawn from the real page with invented sample stories, so nothing private can leak into the repo.
- **Picked the Elasticsearch version myself.** The AI proposed 9.5.1. I asked whether it was stable enough and went with 9.4.8 and the matching 9.4 client.
- **Asked the basic questions before milestone 6:** what is RRF, and what is `ELASTICSEARCH_URL` for? They led to one endpoint with a `mode` parameter and a rule that the code must keep working with Elasticsearch unset.

## Decisions that shaped it
- **TypeScript and Fastify** over Python: it matches the stack I want to work in, and it has built-in schema validation.
- **Milvus Standalone in Docker** from day one, because Milvus Lite is Python-only.
- **FLAT index with cosine similarity:** exact search is fine for a tiny corpus. HNSW can come later as a learning exercise.
- **One chunk per story.** I'll only move to section-level chunking if the vectors turn out too blurry.
- **Vector search and RAG first, then Elasticsearch and hybrid search as milestones 6 and 7,** one new system at a time.
- **Data outside the repo** (`STORIES_DIR`), with a restricted API key (Chat Completions and Embeddings only) and a budget cap.
- **Content-agnostic through configuration, not code.** A "story" is any self-contained piece of content small enough to embed. Files can be `.pdf`, `.txt` or `.md`. By default one file is one story, and a regular expression in `.env` splits a file into many. Ids come from the title unless the pattern captures one. Nothing about my own documents' layout lives in the code.
- **Chat model: `gpt-5.4-mini`.** `gpt-5.4-nano` passed the same eval for about a third of the cost, but its docs page marks it deprecated, so it stays a one-line `.env` switch.
- **A same-origin web page.** The API server also serves the page, so there is no CORS and no key in the browser. History lives only in the page, with no `localStorage`, because answers are derived from private documents.
- **A score cutoff is a setting, not a constant.** `MIN_SCORE` is off unless configured, because cosine scores depend on the embedding model and the content.
- **Eval questions and the query-embedding cache live next to the documents,** in a hidden folder inside `STORIES_DIR`, so nothing derived from private text can reach git.
- **The search method is a per-request `mode`** (vector, keyword or hybrid), with `SEARCH_MODE` as the default. Which method to use is configuration, not code, and the page disables the modes that aren't set up.
- **The keyword analyzer is a setting** (`english` by default, for stemming). If it changes, the Elasticsearch index is recreated on the next ingest, which costs nothing and doesn't touch Milvus.
- **The merge is code, not a model.** RRF only reorders the lists, so hybrid costs the same as vector. The model sees the merged top results and decides for itself which to cite.

## What went wrong, and what I learned
**The setup surprises**
- The `releases/latest/...` Compose download returned a 9-byte "Not Found". Pin a version and check the file.
- `minio/minio` has been pulled from Docker Hub and quay.io now needs auth. The `milvusdb/minio` mirror works.
- On a fresh Docker install, `docker` isn't found until Docker Desktop's first launch and a new shell.
- My Mac was already under memory pressure (13 GB of swap). I freed memory first, capped Docker at 6 GB, and quit Docker when I wasn't using it.
- npm workspaces run scripts from the package folder, so the root `.env` has to be loaded by explicit path.
- My restricted key can't call the Responses API, so the AI has to be told to use Chat Completions.

**The ones that cost me real time**
- **iCloud broke the database.** My repo sat in `~/Documents`, which iCloud syncs. MinIO couldn't write there (`resource deadlock avoided`). Reads worked, but every write stalled. The first ingest embedded every story and then hung on the save, so those embeddings were lost (about $0.0003). The fix was to point `DOCKER_VOLUME_DIRECTORY` at a folder outside iCloud.
- **I hid the problem myself.** I piped the command's output through `tail`, which prints nothing until the command exits, so a stall looked like a silent hang. I now log to a file, and database calls have timeouts so a stall fails loudly.
- **An npm trap that failed silently.** My root script was `npm run ingest -w pkg`. npm treated `--rebuild` as its own option, and the script ran without it. A flag meant to wipe data was ignored. Root scripts now call `tsx` directly.

**The AI and API surprises**
- An API key doesn't pick a model. Every chat call needs a model name. The dashboard doesn't show one to copy, but even a restricted key could list the models on the account.
- Newer chat models want different parameters: `max_completion_tokens` instead of `max_tokens`, and reasoning models can spend hidden tokens unless told not to. Two of the cheaper models I considered are marked deprecated in the docs.
- **My cost estimate was 3× too low.** The spec said about $0.001 per question. With the model I chose it's about $0.0035. Logging the real token usage on every call is what exposed it.
- **A private detail slipped into a code comment.** Reviewing for "anything specific to my documents" turned up a real title in a comment. There is now a rule against it, and a grep for it.
- **A score cutoff can't catch everything.** Correct matches scored 0.25 to 0.60 and unrelated queries 0.01 to 0.16, so a cutoff of 0.2 separates them. But my own "not in the documents" test question scored 0.36, higher than a correct match. A plausible-sounding question that nothing answers looks close in vector space, so the model's "answer only from context" instruction has to handle that case.

**What I got wrong about search**
- **I expected keyword search to lose on paraphrased questions.** I had worded the eval questions differently from the documents on purpose. Keyword search still found the right story in the top 3 for 10 of 10. The English analyzer and the title weighting did more than I guessed.
- **I expected hybrid to return nothing for an unrelated query.** The vector side was cut off by `MIN_SCORE`, but the keyword side has no cutoff, so a weak word match slipped through. A score cutoff on the keyword list is a known gap, and I left it open.
- **Hybrid only tied vector on my test set** (MRR@10 0.950 each). Ten questions about 17 stories can't show the exact-term advantage hybrid is meant to have: even my one exact-term question was answered correctly by all three methods. So I can't claim it yet.
- **RRF can bury a confident vector match.** I tried a conversational question with a typo in it. Vector search had the right story first, but the keyword side ranked it low, and after fusion it dropped to around seventh. RRF uses ranks and throws away how large the score margin was. I also asked why the answer cited a story with a lower RRF score than other retrieved ones. The answer was that RRF only orders the results, and the model chooses what to cite from all of them. I decided not to add a fix yet and wrote the limit into the spec.

## What worked well
- **Closing open questions in the spec before coding.** Fewer surprises and clearer prompts.
- **Writing the eval questions first.** They gave me an honest bar for "is search working?"
- **Doing the infrastructure prework myself.** I know how to start, stop, wipe and debug it.
- **Keeping the AI on a short leash:** plan mode, one milestone at a time, and a review of every diff.
- **Checking for free before paying.** Dry runs, comparing computed hashes with stored ones, cached query vectors, a throwaway folder of made-up files to test file formats, and overriding a setting for one command instead of editing `.env`. Paid calls came last, and each was a single deliberate run.
- **Asking the AI to measure, not guess.** The score cutoff, the model choice and the batch design all came from numbers on my own data.
- **Looking at what the checks can't see.** The eval proves the right story is cited, not that every sentence is true. I added a mechanical check (every number in an answer must appear in the source text) and read a few answers myself.
- **Asking "why" in the middle of a milestone.** "Does ask make two LLM calls?", "What happens at huge volume?" and "Should low scores return nothing?" each led to a better design than the plan I had approved.
- **Comparing the methods for free.** Cached query vectors and a keyword search that never calls OpenAI meant the three-way comparison cost nothing, so I could re-run it whenever I changed something.
- **Reading one real divergence.** The aggregate numbers said hybrid and vector were equal. One conversational question, read rank by rank, taught me more about how RRF behaves than the table did.
- **Keeping the spec honest.** After each change I had the spec compared with the code, and now there's a rule: update it at the end of every milestone.

## By the numbers
| | |
|---|---|
| Stories in the test set | 17, about 700 words each |
| Search: expected story in the top 3 | 10 of 10 for vector, keyword and hybrid (vector ranks 9 first) |
| Ask: answer cites the expected story | 10 of 10; the "not found" case correct; no bad citations |
| Embedding all the stories | 14,584 tokens, about $0.0003 |
| Search quality, MRR@10 (higher is better, 1.0 is perfect) | Hybrid 0.950, vector 0.950, keyword 0.883 |
| One question (search only) | One tiny embedding call, almost free; keyword search makes no OpenAI call at all |
| One question (ask) | One embedding plus one chat call: about $0.0035 with `gpt-5.4-mini`, about $0.001 with nano |
| A full ask eval (11 chat calls) | About $0.03 |
| Total spent on OpenAI | About 11 cents, per the OpenAI dashboard |

## Where it stands
All seven milestones are built, verified and pushed: setup, ingest, search with an eval, ask, the web page, Elasticsearch keyword search, and hybrid search with reciprocal rank fusion. On top of that came the hardened ingest, the model comparison, the content-agnostic rework, the optional score cutoff and a per-request search mode. The spec is at v1.0, there is a README with a screenshot, and `CLAUDE.md` has two new standing rules.

What I haven't done, on purpose:
- **A bigger eval set.** Add conversational questions, typos and exact-term queries (acronyms, product names), which is where hybrid should earn its place.
- **A guard for a confident vector match** that RRF would otherwise push down.
- **A score cutoff on the keyword side,** so weak word matches stop slipping through.
- **Fuzzy matching** for typos in keyword search.

Each of these is a small experiment of its own, and I want a better test set before I decide which ones matter.
