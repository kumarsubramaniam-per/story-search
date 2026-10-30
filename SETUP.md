# story-search — Prework / Setup

One-time setup to do **before** milestone 1 code work. Follow these steps to rebuild the environment on a new Mac, or hand them to someone else trying the project.

---

## 1. Prerequisites

| Tool | Why | Check |
|---|---|---|
| Docker Desktop for Mac | Runs Milvus Standalone (and Elasticsearch in v2) | `docker --version` and `docker compose version` |
| Node.js (current LTS) + npm | Runs the TypeScript / Fastify backend | `node --version` |
| Git | Version control | `git --version` |

Install Docker Desktop from docker.com (or `brew install --cask docker`) and open it once so the Docker engine is running.

Give Docker enough memory: Docker Desktop → Settings → Resources → at least **8 GB** memory is comfortable for Milvus.

---

## 2. Private story folder (outside the repo)

Your content never goes inside `story-search` or into git. Create a private folder anywhere outside the repo, for example:

```bash
mkdir -p ~/private/stories
```

Put your documents in that folder (any depth of sub-folders) and point `STORIES_DIR` at it (step 4). A **story** is any self-contained piece of content small enough to embed as one chunk: an article, a note, an FAQ entry, a Q&A, a case study (up to a few thousand words). Supported files are `.pdf`, `.txt` and `.md`; hidden files and folders are skipped. Two layouts work, and you can mix them (see spec §3):

- **One story per file** (the default): the file's first non-empty line is the story's title.
- **Several stories per file**: set `STORY_HEADER_PATTERN` in `.env` (step 4) to a regular expression matching the line that starts each story.

Each story's id is made from its title (`Getting Started` becomes `getting-started`), unless your pattern captures an id. Ingest strips repeated page headers and footers from PDFs.

Optional: put eval questions here too (`questions.json`, see spec §7); the eval reads them from `STORIES_DIR`, so they stay out of the repo.

---

## 3. OpenAI project and API key

Do this in the **OpenAI API platform** (platform.openai.com), not in ChatGPT. ChatGPT "projects" (instructions, memory, files) are unrelated; API usage is billed separately from any ChatGPT subscription, so the platform account needs its own payment method or credits.

1. Create a **dedicated project** for this app: `story-search`.
2. Set a **monthly budget limit** on that project ($5–10 is plenty; expected spend is a few cents).
3. Create an **API key inside that project**. Copy it once — it isn't shown again.
4. Set the key's permissions to **Restricted**, and under *Model capabilities* set only these two to **Request**:
   - Chat completions (`/v1/chat/completions`)
   - Embeddings (`/v1/embeddings`)

   Leave everything else off (including Responses, `/v1/responses`). The app must therefore call the **Chat Completions API**, not the Responses API.
5. **Note the key's expiration date.** After it expires, calls fail with authentication errors — create a new key in the same project and replace `OPENAI_API_KEY` in `.env`.
6. Don't reuse a personal or work key.

Permission changes can take a few minutes to apply; if the first call fails with a permissions error, wait and retry before debugging.

---

## 4. `.env` file (repo root)

Create `story-search/.env` (git-ignored). Use **absolute paths** — the loader does not expand `~`.

```bash
OPENAI_API_KEY=sk-...                         # project-scoped key from step 3
STORIES_DIR=/Users/<you>/private/stories      # absolute path
CHAT_MODEL=<an OpenAI chat model your key can call>
```

To split files into several stories, add (optional; leave unset for one story per file):

```bash
STORY_HEADER_PATTERN='^## (?<title>.+)$'      # matches the line that starts each story
STORY_BODY_START_PATTERN='...'                # only if titles can wrap over several lines
```

- `STORY_HEADER_PATTERN` is a regular expression. It needs a named group `(?<title>...)` and may have `(?<id>...)` to use your own ids. Examples: `'^## (?<title>.+)$'` for markdown headings; `'^(?<id>[A-Z]\d+) - (?<title>.+)$'` for lines like `A1 - Some Title`.
- `STORY_BODY_START_PATTERN` is a regular expression matching the first line of the body. Lines between the header and that line are added to the title. Leave it unset when titles fit on one line.
- Wrap both in single quotes so backslashes survive.

To hide weak matches, add (optional; unset means no filtering):

```bash
MIN_SCORE=0.2                                 # similarity cutoff, a number between -1 and 1
```

With it set, search returns nothing for a clearly unrelated query, and Ask skips the paid chat call. Cosine scores depend on your content, so pick the value by measurement: after ingesting, `npm run eval` prints the gap between your weakest correct match and your strongest negative case. See spec §7.

To add keyword search with Elasticsearch (optional; the container is set up in step 5):

```bash
ELASTICSEARCH_URL=http://localhost:9200       # setting this turns Elasticsearch on; unset means off
ELASTICSEARCH_ANALYZER=english                # optional: how text is split into terms (default english)
SEARCH_MODE=vector                            # optional: default search method, vector, keyword or hybrid (default vector)
```

`english` stems words (so "scaling" matches "scaled") and drops common ones; for other languages use another built-in analyzer name, such as `german` or `french`. Changing it recreates the Elasticsearch index on the next ingest, which costs nothing and doesn't touch Milvus. See spec §5.

Also commit a `.env.example` with the same variable names and no values.

Notes:
- There is one `.env` at the repo root, shared by all packages. Code loads it by explicit path (three levels up from `packages/api/src`), because npm workspace scripts run from inside each package folder.
- No shell config (`~/.zshrc`) changes are needed.

Check `.gitignore` contains `.env` **before the first commit**.

---

## 5. Milvus Standalone in Docker

Milvus Standalone runs as three containers: `milvus-standalone`, `etcd` (metadata) and `minio` (storage).

From the `story-search` root, download the official Compose file for a **specific** Milvus release. (The `releases/latest/...` shortcut doesn't always work: the newest release may not include this file, and you get a 9-byte "Not Found" file instead.)

```bash
MILVUS_VERSION=v2.6.18   # pick the version shown in the Milvus "Run Milvus with Docker Compose" docs
curl -L https://github.com/milvus-io/milvus/releases/download/$MILVUS_VERSION/milvus-standalone-docker-compose.yml -o docker-compose.yml
head -5 docker-compose.yml   # must show YAML, not "Not Found"
```

**Fix the MinIO image source.** The `minio/minio` image has been removed from Docker Hub, and `quay.io/minio/minio` no longer allows anonymous pulls (401 Unauthorized). The Milvus project now mirrors the same MinIO image on Docker Hub as `milvusdb/minio`. Older release Compose files may still point at the dead locations, so repoint the MinIO line (macOS `sed` syntax):

```bash
sed -i '' -E 's#image: (quay\.io/)?minio/minio:#image: milvusdb/minio:#' docker-compose.yml
grep "image:" docker-compose.yml   # minio line should now read milvusdb/minio:...
```

If a newer Milvus release's Compose file already uses `milvusdb/minio`, this command changes nothing.

Optional: delete the `version: '3.5'` line at the top to silence the "attribute version is obsolete" warning.

Start it:

```bash
docker compose up -d
docker compose ps        # all three should be "running" / "healthy"
```

Milvus listens on **localhost:19530**. Data persists in a `volumes/` folder next to the Compose file — add `volumes/` to `.gitignore`.

**Keep Milvus data out of iCloud-synced folders.** If the repo lives under `~/Documents` (or `~/Desktop`) and iCloud "Desktop & Documents" sync is on, the default `./volumes` bind mount breaks: MinIO fails to write with `resource deadlock avoided`, and Milvus writes (insert/upsert) stall or time out while reads still work. Point the data at a folder outside iCloud by adding an absolute path to `.env` (the Compose file already reads this variable, so `docker-compose.yml` needs no change):

```bash
DOCKER_VOLUME_DIRECTORY=/Users/<you>/milvus-data/story-search   # absolute path; create the folder first
```

Then `./scripts/dev-down.sh --keep-docker && ./scripts/dev-up.sh` to recreate the containers. Milvus starts empty on the new location (old `./volumes` data is not migrated; re-run ingest). If the repo is already outside iCloud-synced folders, you can skip this.

Common commands:

```bash
docker compose stop      # pause (keeps data)
docker compose start     # resume
docker compose down      # remove containers (data in volumes/ is kept)
docker compose logs -f standalone   # troubleshoot
```

To wipe and start clean: `docker compose down` then delete `volumes/`.

**Shortcut scripts (macOS):** once the Compose file is in place, day-to-day start/stop is one command each, run from the repo root:

```bash
chmod +x scripts/*.sh       # once, after cloning
./scripts/dev-up.sh         # starts Docker Desktop if needed, starts Milvus and Elasticsearch, waits until healthy
./scripts/dev-down.sh       # stops the containers and quits Docker Desktop (data kept)
./scripts/dev-down.sh --keep-docker   # stop the containers only
```

These are also available as `npm run dev:up` / `npm run dev:down` from the root `package.json`.

### Optional: Elasticsearch for keyword search

The repo's `docker-compose.yml` also defines an `elasticsearch` service (image `docker.elastic.co/elasticsearch/elasticsearch:9.4.8`, single node, security off, 512 MB heap). `dev-up.sh` starts it with Milvus and waits for it to be healthy.

- **Local only.** Security is off, so the port is bound to `127.0.0.1:9200`; nothing else on your network can reach it. Don't expose it.
- **Memory.** It uses roughly 1 GB on top of Milvus. When you don't need keyword search, `docker compose stop elasticsearch` frees it; `docker compose start elasticsearch` brings it back with its data.
- **Data location.** It stores its data in `volumes/elasticsearch` under `DOCKER_VOLUME_DIRECTORY`, the same folder as Milvus, and the same iCloud warning applies (it relies on file locks).
- **First start** downloads an image of about a gigabyte and takes a minute to become healthy.
- **Turn it on:** set `ELASTICSEARCH_URL` in `.env` (step 4), then run `npm run ingest`. It indexes every story into Elasticsearch without re-embedding anything. If the URL is set but Elasticsearch isn't running, ingest stops before any paid call.
- **Turn it off:** remove `ELASTICSEARCH_URL`. Everything else keeps working with vector search only.
- **Check it:** `curl http://localhost:9200` returns a JSON document with the version.
- If you re-download a fresh Milvus Compose file (above), re-add the `elasticsearch` service from this repo's copy.

Optional: run **Attu**, Milvus's web UI, to browse collections visually.

---

## 6. Verify

Prework is done when:

- [ ] `docker compose ps` shows all three Milvus containers healthy
- [ ] `.env` exists at the repo root with the three required variables (plus `STORY_HEADER_PATTERN` if you split files into several stories); `.env` and `volumes/` are git-ignored
- [ ] Your documents are in the folder `STORIES_DIR` points to (outside the repo)
- [ ] (Optional) with `ELASTICSEARCH_URL` set, `docker compose ps` also shows `story-elasticsearch` healthy
- [ ] OpenAI project has a budget limit
- [ ] A small connection script (milestone 1) connects to `localhost:19530` and prints the Milvus server version

Next: milestone 1 code (monorepo scaffold + connection check), then milestone 2 (ingest + embed + store). See `spec.md`.
