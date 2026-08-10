# 🐛 BugBuddy — Enterprise Bug Capture, Session Replay & AI Triage Platform

BugBuddy is a modern, enterprise-grade bug recording, session replay, and automated AI triage platform. It combines a Chrome Extension (Manifest V3) event recorder, a high-performance Fastify backend, interactive session replay, server-side LLM root cause analysis, and integration export capabilities.

---

## 🌟 Key Features

- **Chrome Extension (Manifest V3)**:
  - **Automated Interaction Capture**: Intercepts `CLICK`, `INPUT`, `NAVIGATE`, `SCROLL`, and `HOVER` events with DOM element selector identification and pre-click context buffering.
  - **Source PII Masking**: Automatically redacts passwords, credit card numbers, email fields, and `data-pii` attributes before events leave the browser.
  - **Visual Screenshot Annotator**: Built-in canvas annotator supporting highlights, callout arrows, custom text labels, and redaction blurring.
  - **Persistent Authentication**: Saved RS256 access & refresh tokens in local extension storage ensure users stay logged in across browser restarts.
- **▶ Interactive Session Replay & WebM Video Export**:
  - **Visual Timeline Scrubber**: Playback captured session timelines step-by-step with play/pause, step controls, and speed selectors (`0.5x`, `1x`, `2x`, `4x`).
  - **🎥 WebM Session Video Generator**: Render session steps, screenshot overlays, and timestamps into downloadable `.webm` video recordings directly from the extension.
- **🧠 AI Root-Cause Triage & Stacktrace Analysis**:
  - **Dual Triage Engine**: Combines OpenAI GPT-4o-mini server-side analysis with an offline **Heuristic Triage Engine** fallback.
  - **Stacktrace & Log Analysis**: Parses failed HTTP network requests (4xx/5xx) and uncaught console exceptions to diagnose root cause, affected components (`FRONTEND`, `BACKEND`, `EXTERNAL_API`), and recommended code fixes.
- **🔌 Enterprise Integrations & Export**:
  - **One-Click Dispatch**: Dispatch structured bug reports directly to **Jira**, **Azure DevOps**, and **Slack**.
  - **Local Export Options**: Download complete standalone HTML and PDF bug reports.

---

## 🏗️ Architecture Overview

The repository is structured as a `pnpm` workspace monorepo managed by **Turbo Repo**:

```
BugBuddy/
├── packages/
│   ├── shared/       # Shared TypeScript schemas (Zod), DTO types, & enums
│   ├── backend/      # Fastify API server, Auth, AI routes, PostgreSQL pool, & BullMQ workers
│   ├── extension/    # Chrome Extension (Vite + React + MV3 Background Worker & SidePanel)
│   └── web/          # Next.js web dashboard interface
├── docker-compose.yml # Production Docker orchestration (Postgres, Redis, MinIO, Nginx)
├── docker-compose.dev.yml # Dev infrastructure services
└── upgrades.txt      # Enterprise feature roadmap
```

---

## 📋 Prerequisites

Ensure your development environment meets the following requirements:

- **Node.js**: `v20.0.0` or higher
- **pnpm**: `v9.0.0` or higher (`npm install -g pnpm`)
- **Google Chrome**: For running the Chrome Extension
- **Docker & Docker Compose** *(Optional for database/redis/minio services)*

---

## ⚙️ Detailed Setup Guide

### 1. Clone & Install Dependencies

```bash
# Clone the repository
git clone https://github.com/ChiranSwech/BugBuddy.git
cd BugBuddy

# Install monorepo dependencies
pnpm install
```

### 2. Configure Environment Variables

Copy `.env.example` to `.env` in the root directory:

```bash
cp .env.example .env
```

Open `.env` and configure key variables:

```ini
# PostgreSQL & Redis Passwords
POSTGRES_PASSWORD=your_strong_postgres_password
REDIS_PASSWORD=your_strong_redis_password

# MinIO Object Storage Keys
MINIO_ACCESS_KEY=minio_access_key
MINIO_SECRET_KEY=minio_secret_key_8_chars

# Google OAuth 2.0 Credentials (from Google Cloud Console)
GOOGLE_CLIENT_ID=your_client_id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your_client_secret

# Backend Secrets (Generate with: openssl rand -hex 32)
SESSION_SECRET=a_random_64_character_hex_string_here
ENCRYPTION_KEY=a_random_32_byte_hex_string_here

# OpenAI API Key (Optional — fallback heuristic triage runs if blank)
OPENAI_API_KEY=sk-...

# Integrations (Optional)
JIRA_BASE_URL=https://yourcompany.atlassian.net
JIRA_API_TOKEN=your_jira_token
JIRA_PROJECT_KEY=BUG
```

### 3. Start Infrastructure Services

You can launch PostgreSQL, Redis, and MinIO using Docker Compose:

```bash
docker-compose -f docker-compose.dev.yml up -d
```

### 4. Build Commands & Generating Local Chrome Extension

#### Generate Local Chrome Extension Only
To build the Chrome Extension dist bundle locally:

```bash
pnpm run build:extension
```
*Output build directory*: `packages/extension/dist`

#### Extension Watch Mode (Live Rebuild during development)
To automatically rebuild the extension whenever you make changes to extension files:

```bash
pnpm --filter @bugbuddy/extension dev
```

#### Build All Workspace Packages
To compile all monorepo packages (`shared`, `backend`, `extension`, `web`):

```bash
pnpm run build
```

### 5. Start Backend API & Extension Development Servers

```bash
pnpm run dev
```

The Fastify backend server starts at `http://localhost:8080`.

---

## 🧩 Loading the Local Chrome Extension into Browser

1. Open **Google Chrome** and navigate to `chrome://extensions`.
2. Enable **Developer mode** in the top-right toggle switch.
3. Click **Load unpacked**.
4. Select the directory: `<path-to-repo>/packages/extension/dist`.
5. The **BugBuddy** extension icon will now appear in your browser toolbar.

---

## 📖 Usage Steps

### 1. Log In via Extension
- Click the **BugBuddy** extension icon to open the popup interface.
- Click **Continue with Google**.
- Complete the Google OAuth login window. Once authenticated, your session persists across browser restarts.

### 2. Record a Test Session
- Navigate to any web application you want to test.
- Click **● Start Recording** in the extension popup.
- Perform interactions on the page (clicks, input entries, navigations).
- *Hotkeys*:
  - `Ctrl + I`: Manually capture a screenshot at the current step.
  - `Ctrl + Shift + P`: Pause / Resume recording.
- Click **■ Stop & Review** to finish recording and open the Review SidePanel.

### 3. Interactive Session Replay & WebM Export
- Open the SidePanel and select the **▶ Replay** tab.
- Use **Play / Pause**, **Prev / Next Step**, or speed toggles (`0.5x`, `1x`, `2x`, `4x`) to review visual step progression.
- Drag the timeline scrubber to jump directly to any step.
- Click **🎥 Export WebM Video** to generate and download a smooth WebM video file of the session.

### 4. Run AI Root-Cause Triage
- Open the **Report** or **Timeline** tab in the SidePanel.
- Click **⚡ Run Root Cause Triage**.
- The AI Triage Engine analyzes network failures, console stack traces, and steps to output:
  - Primary Root Cause
  - Affected Component (`FRONTEND`, `BACKEND`, `EXTERNAL_API`)
  - Detailed Technical Summary
  - Recommended Code Fix

### 5. Submit Bug Report & Export Integrations
- Fill out the Title, Description, Expected Result, and Actual Result.
- Select Bug Severity (`P0` - `P4`).
- *(Optional)* Toggle integrations (**Jira**, **Slack**, **Azure DevOps**) to dispatch the bug directly to your project management tools.
- Click **📄 Export HTML** or **📕 Export PDF** for standalone local downloads.
- Click **🐛 Submit Bug Report** to send the report to the BugBuddy backend platform.

---

## 🛠️ Complete CLI Command Reference

| Command | Action / Description |
| :--- | :--- |
| **`pnpm run build:extension`** | **Build local Chrome Extension bundle to `packages/extension/dist`** |
| `pnpm --filter @bugbuddy/extension dev` | Watch mode: auto-rebuild Chrome extension on file changes |
| `pnpm run build:backend` | Build backend API server to `packages/backend/dist` |
| `pnpm run build:shared` | Build shared TypeScript Zod schemas and types |
| `pnpm run build:web` | Build Next.js web dashboard app |
| `pnpm run build` | Build all workspace packages concurrently via Turbo Repo |
| `pnpm run dev` | Start development servers concurrently across packages |
| `pnpm --filter @bugbuddy/backend db:migrate` | Run database SQL migrations up |
| `pnpm run typecheck` | Run TypeScript type checking across the monorepo |
| `pnpm run lint` | Run ESLint checks across codebase |
| `pnpm run clean` | Clean build outputs (`dist/`, `.turbo/`) and `node_modules` |

---

## 🔒 Security & Privacy

- **Isolated Execution**: Content scripts run in isolated JS worlds and never expose internal DOM nodes to unauthenticated context.
- **Client-Side Masking**: All PII (passwords, emails, credit cards) is masked at the source in content scripts before being sent to background workers or servers.
- **JWT Key Persistence**: Backend uses RS256 keypairs generated and stored securely in persistent container volumes.
