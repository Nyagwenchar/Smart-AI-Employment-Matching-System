# Requirements and Installation Guide

Everything a **new PC** needs to run KaziConnect (Smart AI Employment Matching System)
from a clean machine. Follow the sections in order; the whole setup takes about 20 minutes.

---

## 1. Hardware

| Item | Minimum | Recommended |
| --- | --- | --- |
| CPU | 2 cores | 4 cores or more |
| RAM | 4 GB | 8 GB (16 GB if you enable the local model tier) |
| Disk | 1 GB free | 5 GB free (adds ~2.5 GB for a local GGUF model) |
| Network | Needed for `npm install` and the Gemini tier | — |

The app runs fine on a laptop with no GPU. The optional local model tier uses Vulkan/Metal
when a GPU is present and falls back to CPU when it is not.

---

## 2. Software to install

### 2.1 Node.js 20 LTS or newer (required)

```powershell
winget install OpenJS.NodeJS.LTS
```

Verify in a **new** terminal:

```powershell
node --version   # must print v20.x or newer (v22 LTS recommended)
npm --version
```

Download page: <https://nodejs.org/en/download>

### 2.2 PostgreSQL 17 (required)

```powershell
winget install PostgreSQL.PostgreSQL.17
```

During installation:

- Set a password for the `postgres` superuser and remember it — it goes into `.env` as `DB_PASSWORD`.
- Keep the default port `5432`.
- Keep the default locale.

Verify:

```powershell
psql --version
```

> If `psql` is not on `PATH`, add `C:\Program Files\PostgreSQL\17\bin` to the system `PATH`.

### 2.3 Git (optional, only for cloning the repository)

```powershell
winget install Git.Git
```

### 2.4 Build tools (optional, only if the local model tier fails to install)

`node-llama-cpp` ships prebuilt binaries for Windows, macOS and Linux. If `npm install`
reports that no prebuilt binary is available, install the compiler toolchain:

```powershell
winget install Python.Python.3.12
winget install Microsoft.VisualStudio.2022.BuildTools
```

In the Visual Studio Installer, tick **Desktop development with C++**.

### 2.5 A modern browser

Chrome, Edge or Firefox, current version. The pages use Tailwind (CDN), Chart.js and Lucide icons.

---

## 3. Accounts and keys

| Service | Required? | Purpose | Where to get it |
| --- | --- | --- | --- |
| Google Gemini API key | Recommended | Tier 1 of the AI chain | <https://aistudio.google.com/apikey> (free tier) |
| Groq / OpenRouter key | Optional | Tier 2 backup model | <https://console.groq.com/keys> or <https://openrouter.ai/keys> |
| GGUF model file | Optional | Tier 3 embedded local model | Any GGUF release, e.g. a 4B `Q4_K_M` instruct model (~2.5 GB) |

With none of these keys the app still works: it falls back to the deterministic offline engine,
and match percentages and recommendations keep the same format.

---

## 4. First-time setup

Run these commands in PowerShell from the project folder.

```powershell
# 1. Install JavaScript dependencies (about 2 minutes)
npm install

# 2. Create your environment file and fill it in
Copy-Item .env.example .env
notepad .env
```

Fill in at minimum:

```ini
DB_HOST=localhost
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=your-postgres-password
DB_NAME=Smart AI Employment Matching System
JWT_SECRET=any-long-random-string-at-least-32-characters
GEMINI_API_KEY=your-gemini-key      # optional but recommended
```

Generate a strong JWT secret with Node:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

```powershell
# 3. Create the database, load the baseline schema and apply migrations
npm run db:migrate

# 4. Optional: insert demo employers and job listings
npm run seed

# 5. Start the application
npm start
```

Open <http://localhost:3000>.

`npm run db:migrate` is idempotent: it creates the database if it is missing, loads
`Smart AI Employment Matching System Database.sql` once, then applies every file in
`db/migrations/` (currently the matching-engine tables and columns). Re-running it is safe.

---

## 5. Environment variables

All variables live in `.env` (see `.env.example` for the annotated template).

### Database and auth

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `DB_HOST` | yes | — | PostgreSQL host |
| `DB_PORT` | yes | — | PostgreSQL port |
| `DB_USER` | yes | — | PostgreSQL user |
| `DB_PASSWORD` | yes | — | PostgreSQL password |
| `DB_NAME` | yes | — | Database name |
| `JWT_SECRET` | yes | — | Signs login tokens; the server refuses to start without it |
| `PORT` | no | `3000` | HTTP port |

### AI tiers

| Variable | Default | Meaning |
| --- | --- | --- |
| `LLM_ENABLED` | `true` | Master switch for every online tier |
| `GEMINI_API_KEY` | empty | Enables tier 1 |
| `GEMINI_MODEL` / `GEMINI_FALLBACK_MODELS` | `gemini-3.1-flash-lite` / `gemini-3.8-flash` | Model chain tried in order |
| `GEMINI_TIMEOUT_MS` / `GEMINI_TOTAL_BUDGET_MS` | `10000` / `10500` | Per-attempt and whole-chain ceilings |
| `LLM_BUDGET_MS` | `32000` | Ceiling for one task across every tier |
| `LLM_RANKING_BUDGET_MS` | `12000` | Ceiling for recommendation ordering |
| `LLM_COOLDOWN_MS` | `60000` | How long a failing tier is skipped |
| `BACKUP_LLM_ENABLED` / `_API_KEY` / `_MODEL` | `true` / empty / empty | Tier 2 (OpenAI-compatible) |
| `BACKUP_LLM_BASE_URL` | Groq | Any OpenAI-compatible endpoint |
| `LOCAL_LLM_MODEL_PATH` | empty | Path to a `.gguf` file; enables tier 3 |
| `LOCAL_LLM_CONTEXT` / `LOCAL_LLM_GPU_LAYERS` | `8192` / `auto` | Local model runtime settings |

The active tier is shown on every dashboard as a badge and is available at
`GET /api/ai/status`.

---

## 6. Packages installed by `npm install`

### Runtime dependencies (declared in `package.json`)

| Package | Version | Used for |
| --- | --- | --- |
| `express` | ^5.3.0 | HTTP server and routing |
| `pg` | ^8.23.1 | PostgreSQL driver |
| `jsonwebtoken` | ^9.0.3 | Login tokens (2-hour expiry) |
| `bcryptjs` | ^3.0.3 | Password hashing (pure JavaScript, no compiler needed) |
| `dotenv` | ^18.0.8 | Loads `.env` into `process.env` |
| `multer` | ^2.4.0 | CV file uploads (PDF/DOCX, 5 MB limit) |
| `pdf-parse` | ^1.1.1 | Text extraction from PDF CVs |
| `mammoth` | ^1.13.0 | Text extraction from DOCX CVs |

### Optional dependency

| Package | Version | Used for |
| --- | --- | --- |
| `node-llama-cpp` | ^3.22.3 | Tier 3 embedded local model (GGUF) |

If this optional package cannot be installed on the target machine, skip it:

```powershell
npm install --omit=optional
```

The app then runs with Gemini, the hosted backup and the offline engine; the badge simply
reports the local tier as not configured.

There are **no** development dependencies and no global packages required.

---

## 7. Verify the installation

```powershell
# Parser, scoring engine and the full four-tier AI chain (no database needed)
npm test

# Inline JavaScript in every page parses
npm run check:inline

# End-to-end run against a live server (needs PostgreSQL and `npm start` in another terminal)
npm run smoke:e2e
```

`npm test` runs three suites:

- `smoke:cv` — CV text to structured skills, education and experience
- `smoke:match` — deterministic scoring against four sample jobs
- `smoke:ai` — 66 assertions covering Gemini, the hosted backup, the embedded local
  model and the offline engine, including tier ordering and cooldown behaviour

Expected result: every check prints `ok`, ending with `66/66 checks passed`.

---

## 8. Running in production

```powershell
$env:NODE_ENV = "production"
npm start
```

Recommendations:

- Put the Node process behind IIS, nginx or Caddy with HTTPS.
- Run it as a service (NSSM, PM2 or a Windows service wrapper) so it restarts on reboot.
- Keep `.env` readable only by the service account — it is excluded from version control.
- `uploads/` holds personal CV files. Back it up or point it at encrypted storage, and
  prune old files periodically.
- Rotate `JWT_SECRET` and all API keys if they were ever shared in plain text.

### Create an administrator account

Self-registration only creates job seekers and employers. To promote an account to the
admin portal (`/admin-dashboard.html`), run in `psql`:

```sql
UPDATE users SET role = 'admin', account_type = 'admin' WHERE email = 'you@example.com';
```

---

## 9. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Missing required environment variables: ...` | `.env` incomplete | Fill in the listed keys and restart |
| `ECONNREFUSED` on start | PostgreSQL not running | Start the `postgresql-x64-17` service |
| `password authentication failed` | Wrong `DB_PASSWORD` | Fix `.env`, then `npm run db:migrate` |
| `database "..." does not exist` | Schema never applied | `npm run db:migrate` |
| Badge reads `AI: Offline engine` | No key, or every tier failed | Check `/api/ai/status` for the per-tier reason |
| Badge reads `AI: Offline engine (models busy)` | A tier was rate limited | Wait for the 60-second cooldown |
| CV upload says "No readable text found" | Scanned/image-only PDF | Export a text-based PDF or upload DOCX |
| `npm install` fails on `node-llama-cpp` | No prebuilt binary | Install Build Tools + Python, or `npm install --omit=optional` |
| Port 3000 already in use | Another server is running | `netstat -ano | findstr :3000`, then stop that PID |
