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

The story bank never goes inside `story-search` or into git. Create a private folder anywhere outside the repo, for example:

```bash
mkdir -p ~/private/story-bank
```

Put your story bank document in that folder and point `STORIES_DIR` at it (step 4). Expected input format (see spec §3):

- A PDF containing the stories
- Each story starts with a short code header (e.g. `A1`) followed by its title
- Ingest splits one chunk per story, uses the code as `story_id`, and strips repeated page headers/footers

Optional: put the eval questions here too (instead of `packages/eval/questions.json`) if the repo will ever be public.

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

Create `story-search/.env` (git-ignored). Use **absolute paths** — `dotenv` does not expand `~`.

```bash
OPENAI_API_KEY=sk-...                         # project-scoped key from step 3
STORIES_DIR=/Users/<you>/private/story-bank   # absolute path
CHAT_MODEL=<OpenAI's current small chat model>
```

Also commit a `.env.example` with the same variable names and no values.

Notes:
- There is one `.env` at the repo root, shared by all packages. Code loads it by explicit path (two levels up from the package source), because npm workspace scripts run from inside each package folder.
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
./scripts/dev-up.sh         # starts Docker Desktop if needed, starts Milvus, waits until healthy
./scripts/dev-down.sh       # stops Milvus and quits Docker Desktop (data kept)
./scripts/dev-down.sh --keep-docker   # stop Milvus only
```

These are also available as `npm run dev:up` / `npm run dev:down` from the root `package.json`.

Optional: run **Attu**, Milvus's web UI, to browse collections visually.

---

## 6. Verify

Prework is done when:

- [ ] `docker compose ps` shows all three Milvus containers healthy
- [ ] `.env` exists at the repo root with all three variables; `.env` and `volumes/` are git-ignored
- [ ] Story bank document is in the folder `STORIES_DIR` points to (outside the repo)
- [ ] OpenAI project has a budget limit
- [ ] A small connection script (milestone 1) connects to `localhost:19530` and prints the Milvus server version

Next: milestone 1 code (monorepo scaffold + connection check), then milestone 2 (ingest + embed + store). See `spec.md`.
