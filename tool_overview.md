# BugBuddy — Detailed Tool & Framework Overview

This document provides a comprehensive analysis of the BugBuddy platform's technology stack, architecture, folder structure, event lifecycle, development setup, and cloud hosting configuration.

---

## 1. Technologies & Dependencies

BugBuddy is built on a modern **monoreposity** architecture, splitting responsibilities between a Chrome extension, a Fastify backend, a Next.js web portal, and a shared schema library.

### Monorepo & Build System
*   **Turborepo (v2.3.3):** Manages task pipelines, build orchestration, and caching to speed up local and CI runs.
*   **pnpm Workspaces (v9.15.0):** Manages external packages and symlinks local package workspaces (`@bugbuddy/shared`, `@bugbuddy/backend`, etc.) with optimal disk footprint.
*   **TypeScript (v5.7.x):** Used across all packages to enforce runtime type safety and compilation reliability.

### Backend Infrastructure (Fastify API & Workers)
*   **Fastify (v5.2.1):** A high-performance, low-overhead Node.js web framework.
*   **Fastify Plugin Ecosystem:**
    *   `@fastify/cors`: Handles Cross-Origin Resource Sharing.
    *   `@fastify/cookie`: Signed cookie support for secure HTTP-only session flows.
    *   `@fastify/rate-limit`: In-memory rate-limiter to mitigate brute-force and DDoS attempts.
    *   `@fastify/multipart`: Handles raw multipart file streams for attachment uploads (up to 20MB).
    *   `@fastify/helmet`: Enforces security headers (CSP, HSTS, Frameguard).
*   **BullMQ (v5.38.0) & ioredis (v5.4.2):** Message broker and queue manager for background workers, ensuring asynchronous, non-blocking tasks are executed durably.
*   **PostgreSQL (`pg` v8.14.1):** Relational persistence layer.
*   **node-pg-migrate (v7.8.2):** Manages versioned SQL schema migrations.
*   **MinIO Client (v8.0.3):** Connects to S3-compatible object storage for file attachments and screenshots.
*   **jose (v5.10.0):** Signs and validates JWT access tokens via asymmetric keypairs (RS256).
*   **sharp (v0.33.5):** Performs lightning-fast image editing (used by workers for server-side PII redactions).

### Chrome Extension Context
*   **React (v18.3.1):** Powers the user-facing SidePanel interface.
*   **Vite (v6.3.5):** Compiles extension assets with fast hot module replacement.
*   **Chrome Extension MV3 APIs:**
    *   `chrome.debugger`: Intercepts DevTools network streams and console logs.
    *   `chrome.storage.session`: Temporarily stores OAuth credentials, cleared automatically when the browser closes.
    *   `chrome.sidePanel`: Renders a sliding side interface alongside active websites.

### Web Dashboard (Next.js Developer Portal)
*   **Next.js (v14.2.3):** Leverages App Router layouts and server rendering.
*   **Tailwind CSS (v4.3.0):** A utility-first styling engine used to construct the triage portal.
*   **Lucide React (v0.378.0):** Rich vector icon asset suite.

---

## 2. Technology Selection: Choices & Alternatives

| Choice | Alternative considered | Rationale for selection |
| :--- | :--- | :--- |
| **Fastify** | Express.js / NestJS | Fastify handles up to 3x higher request throughput than Express. It has built-in schema serialization (via Ajv) and async-first design. It avoids the heavy boilerplate and reflection overhead of NestJS. |
| **Vite** | Webpack | Vite builds the extension modules in milliseconds using `esbuild` and delivers near-instantaneous hot-reloading during extension development compared to Webpack's complex and slow configuration. |
| **Next.js** | Single Page React App | Next.js simplifies auth callbacks and JWT key validation through API routes and Server Components. It eliminates the complexity of setting up custom client-side routers and custom bundlers. |
| **BullMQ & Redis** | In-Memory Array / Cron | In-memory queues lose all pending operations if the server restarts. BullMQ guarantees job persistence, handles concurrency control, and automatically retries integration failures with exponential back-off. |
| **PostgreSQL** | MongoDB | BugBuddy handles multi-tenant access levels, audit trails, and strict relationships (`orgs` -> `users` -> `sessions` -> `bugs`). PostgreSQL ensures ACID transactional compliance and fast indexing over JSONB fields and text search. |
| **MinIO Client** | AWS-only SDK | By targeting S3-compatible client calls, BugBuddy remains stateless and provider-agnostic. Developers can run MinIO locally inside Docker, and seamlessly change to AWS S3, Cloudflare R2, or Google Cloud Storage in production by changing environment URLs. |

---

## 3. Project Structure

Below is the directory mapping of the BugBuddy monorepo:

```
BugBuddy/
├── .env.example                    # Global environment variable template
├── package.json                    # Root workspace definitions and build commands
├── pnpm-workspace.yaml             # pnpm monorepo structure declaration
├── turbo.json                      # Turborepo build pipeline and cache rules
├── docker-compose.dev.yml          # Local infrastructure (Postgres, Redis, MinIO)
├── docker-compose.yml              # Production target infrastructure with reverse proxy
├── nginx/                          # Nginx config files (SSL/Reverse Proxy)
└── packages/
    ├── shared/                     # Cross-project code, validators, and types
    │   ├── src/
    │   │   ├── schemas/            # Zod schemas (bug, user, session, attachment)
    │   │   ├── crypto/             # Shared cryptographic algorithms
    │   │   └── index.ts            # Entrypoint compiling shared exports
    ├── backend/                    # Fastify API Server & Background Workers
    │   ├── db/                     # DB schemas, init scripts, and migrations
    │   ├── keys/                   # Folder holding generated JWT RS256 keys
    │   ├── src/
    │   │   ├── app.ts              # Core Fastify setup (middleware, rate limits, CORS)
    │   │   ├── config.ts           # Zod-verified environment configuration
    │   │   ├── server.ts           # API Listener starter
    │   │   ├── auth/               # Google OAuth, access/refresh tokens, cryptography
    │   │   ├── bugs/               # Bug ingestion, queries, and details routes
    │   │   ├── db/                 # Postgres pool & Redis client initialisation
    │   │   ├── integrations/       # Outbound channels (Jira, Slack, DevOps)
    │   │   └── workers/            # BullMQ processing for PII and Integration Dispatches
    ├── extension/                  # Chrome Extension MV3
    │   ├── src/
    │   │   ├── background/         # Service worker: CDP debugger logger
    │   │   ├── content/            # Injected script: Event listener & storage snapshot
    │   │   ├── devtools/           # Developer tools panel instantiation
    │   │   └── sidepanel/          # React side UI (submit, review, markup annotations)
    └── web/                        # Next.js web application (Developer Portal)
        └── src/app/                # App Router UI, triage dashboard, and views
```

---

## 4. Application Flow

The life cycle of a bug capture session, from recording to developer resolution:

```mermaid
sequenceDiagram
    autonumber
    actor QA as QA Engineer / Tester
    participant CS as Content Script
    participant BG as Background Worker
    participant SP as SidePanel UI
    participant API as Fastify API Server
    participant DB as PostgreSQL
    participant S3 as MinIO / S3 Storage
    participant Q as BullMQ (Redis)
    actor Dev as Developer (Triage)

    %% Session recording
    QA->>SP: Click "Start Recording"
    SP->>BG: Initiate CDP Debugger Connection
    activate BG
    Note over BG: chrome.debugger attaches to tab<br/>Listens to Console & Network
    CS->>CS: Capture DOM user interactions (Clicks, inputs, scrolls)
    QA->>CS: Perform actions on Target Page
    CS->>BG: Stream user events and screenshot coordinates
    BG->>BG: Buffer Console Errors & Network Payloads (<50KB)
    deactivate BG

    %% Submission
    QA->>SP: Stop recording & Click "Submit Bug"
    SP->>CS: Extract sessionStorage / localStorage
    CS->>CS: Redact auth tokens & passwords (client-side)
    CS->>SP: Send Sanitized Storage Snapshot
    SP->>API: Send structured JSON Payload (Zod validated) + Base64 attachments
    activate API

    %% Backend storage transaction
    API->>DB: INSERT session, bug metadata, and step actions
    API->>S3: Upload raw screenshots (Base64 -> Binary)
    API->>DB: INSERT attachments (storage_key references)
    API->>Q: Enqueue PII Redaction & Integration Dispatch jobs
    API->>SP: Return 201 Created (Bug ID)
    deactivate API

    %% Background processing
    Note over Q: BullMQ Workers pick up jobs
    Q->>S3: Download screenshots, apply PII blackbars (Sharp) & re-upload
    Q->>DB: Decrypt integrations, dispatch bug to Slack / Jira

    %% Developer triage
    Dev->>API: Load Bug Triage page on Next.js Portal
    API->>DB: Query bug records & step lists
    API->>S3: Request 1-hour pre-signed access URLs for screenshots
    API->>Dev: Render interactive event replay timeline
```

### Flow Breakdown

#### Step 1: Session Recording
*   **Layman:** The QA tester clicks "Start Recording" in the extension. When they interact with the page, the tool records their steps and captures screenshots. Behind the scenes, it also registers console messages and API requests.
*   **Technical:** The content script (`content/index.ts`) registers listeners for standard DOM events (clicks, keypresses). The background script (`background/index.ts`) uses `chrome.debugger` to attach to the page. It hooks into the `Runtime` domain to intercept errors, and the `Network` domain to store HTTP metadata and response payloads (capped at 50KB).

#### Step 2: Submission & Local Sanitation
*   **Layman:** The tester reviews their action logs, describes the bug, and hits submit.
*   **Technical:** The React SidePanel gathers logs and screenshots. The content script extracts `localStorage` and `sessionStorage` keys and filters them against common credential patterns (e.g. `jwt`, `token`, `password`) to redact them client-side. The compiled diagnostics payload is POSTed to the backend API.

#### Step 3: API Ingestion
*   **Layman:** The backend API processes the bug report, uploads screenshots to cloud storage, and stores the details in the database.
*   **Technical:** The Fastify server parses the payload using `CreateBugSchema` (Zod). In a single SQL transaction, it stores the bug, steps, and attaches files. Base64 screenshots are converted to binaries, written to MinIO, and referenced in the `attachments` table.

#### Step 4: Background Workers
*   **Layman:** The system automatically reviews the screenshots for confidential data and sends notifications to external tools (like Slack or Jira).
*   **Technical:** Fastify schedules background tasks via BullMQ. The `pii-redaction` worker runs server-side cleanup. The `integration-dispatch` worker pulls target configuration keys, decrypts them using the server's `ENCRYPTION_KEY`, and fires webhooks or API requests.

#### Step 5: Triage
*   **Layman:** The developer opens the dashboard, chooses the bug, and views the exact steps the tester performed.
*   **Technical:** The Next.js dashboard retrieves the structured bug timeline. The backend server queries MinIO to generate short-lived presigned URLs for screenshots, allowing secure image loading on the developer's client.

---

## 5. Local IDE Setup Guide

Ensure your development environment meets these prerequisites:
*   **Node.js:** `>=20.0.0`
*   **pnpm:** `>=9.0.0`
*   **Docker & Docker Compose** (Desktop or CLI)

### Step 1: Install Dependencies
From the root workspace folder, run:
```bash
pnpm install
```

### Step 2: Configure Local Environment Variables
1. Copy the example template into a local file:
   ```bash
   cp .env.example .env
   ```
2. Generate 32-byte hexadecimal strings for security keys:
   ```bash
   openssl rand -hex 32
   ```
3. Open the newly created `.env` file (do NOT edit inside this conversation thread) and set your keys:
   *   `SESSION_SECRET`: Paste the generated hex string.
   *   `ENCRYPTION_KEY`: Paste the generated hex string.
   *   `POSTGRES_PASSWORD`: E.g., `devpassword` (Must match `docker-compose.dev.yml`).
   *   `REDIS_PASSWORD`: E.g., `devpassword`.

### Step 3: Run Database, Cache, and Storage Containers
Spin up the local PostgreSQL, Redis, and MinIO storage systems:
```bash
docker compose -f docker-compose.dev.yml up -d
```
Verify they are running by checking `docker ps`.

### Step 4: Initialize the Database
Run migrations to build schemas and tables in the PostgreSQL database:
```bash
pnpm --filter @bugbuddy/backend db:migrate
```

### Step 5: Boot Dev Servers
Start the dev servers for the extension, backend, and web dashboard:
```bash
pnpm dev
```
This triggers Turborepo to run the dev commands in parallel:
*   **Extension builds:** Outputs compiled code dynamically into `packages/extension/dist`.
*   **Backend server:** Runs on `http://localhost:3001` (Auto-reloading with tsx).
*   **Next.js UI:** Runs on `http://localhost:3000`.

### Step 6: Install the Extension in your Browser
1. Open Google Chrome (or any Chromium browser).
2. Navigate to `chrome://extensions/`.
3. Enable the **Developer mode** toggle in the top-right corner.
4. Click **Load unpacked** in the top-left corner.
5. Select the `packages/extension/dist` directory from the repository.

---

## 6. Hosting Setup Guide (Production Deployments)

To host BugBuddy in a production cloud environment, you can use serverless databases, managed key-value stores, and app hosting platforms like **Neon**, **Upstash**, and **Render**.

### Database Configuration (Neon)
[Neon](https://neon.tech/) provides serverless PostgreSQL with autoscaling and branching capabilities.
1. Sign in to Neon and create a new project.
2. In the Neon dashboard, choose a database name (e.g. `bugbuddy_prod`).
3. Copy the **connection string** (pooled version is recommended for API endpoints).
4. Run migrations locally targeting the Neon database to provision tables:
   ```bash
   DATABASE_URL="postgresql://user:password@neon-host/bugbuddy_prod?sslmode=require" pnpm --filter @bugbuddy/backend db:migrate
   ```

### Redis Cache & Queues (Upstash)
[Upstash](https://upstash.com/) provides serverless Redis databases with low overhead.
1. Create a Redis database on Upstash.
2. Under database details, copy the **Redis URL** (should begin with `redis://` or secure `rediss://`).
3. Save this value for the backend environment configurations.

### S3 Object Storage (AWS S3 or Cloudflare R2)
Cloudflare R2 is recommended due to its zero egress fees.
1. Create a bucket named `bugbuddy-attachments` in your Cloudflare R2 dashboard.
2. Generate an Access Key ID and Secret Access Key (S3 API Credentials).
3. Copy the S3 API endpoint URL (e.g. `<account-id>.r2.cloudflarestorage.com`).

### App Server & Worker Hosting (Render)
[Render](https://render.com/) is an easy-to-use platform for hosting Node.js servers, workers, and static sites.

```mermaid
graph TD
    subgraph Render Platform
        A[API Web Service]
        B[Background Worker Service]
        C[Static Frontend Site]
    end
    subgraph Managed Cloud
        D[(Neon Serverless DB)]
        E[(Upstash Serverless Redis)]
        F[(Cloudflare R2 Storage)]
    end
    
    A --> D
    A --> E
    A --> F
    B --> D
    B --> E
    B --> F
    C --> A
```

#### 1. Deploy the API Web Service
1. Create a new **Web Service** on Render and link it to your GitHub repository.
2. Configure these parameters:
   *   **Root Directory:** `packages/backend`
   *   **Runtime:** `Docker`
   *   **Docker Build Context:** `../..` (Specifies the root directory as the context for multi-stage Docker build)
   *   **Docker Target Stage:** `production`
3. Add the following **Environment Variables**:
   *   `NODE_ENV`: `production`
   *   `PORT`: `3001`
   *   `DATABASE_URL`: `your_neon_connection_string`
   *   `REDIS_URL`: `your_upstash_redis_url`
   *   `MINIO_ENDPOINT`: `your_r2_endpoint_host` (e.g., `<id>.r2.cloudflarestorage.com`)
   *   `MINIO_PORT`: `443`
   *   `MINIO_USE_SSL`: `true`
   *   `MINIO_ACCESS_KEY`: `your_r2_access_key`
   *   `MINIO_SECRET_KEY`: `your_r2_secret_key`
   *   `MINIO_BUCKET`: `bugbuddy-attachments`
   *   `SESSION_SECRET`: `your_generated_32_byte_hex_string`
   *   `ENCRYPTION_KEY`: `your_generated_32_byte_hex_string`
   *   `CORS_ORIGIN`: `https://your-frontend-domain.com`
   *   `API_BASE_URL`: `https://your-backend-api-domain.com`

#### 2. Deploy the Background Worker
The background worker handles long-running jobs (PII redaction and integration dispatches) asynchronously without blocking API responses.
1. Create a new **Background Worker** on Render and link it to the same repository.
2. Configure:
   *   **Root Directory:** `packages/backend`
   *   **Runtime:** `Docker`
   *   **Docker Build Context:** `../..`
   *   **Docker Target Stage:** `worker`
3. Copy all **Environment Variables** defined in the API Web Service above.

#### 3. Deploy the Next.js Frontend Dashboard
1. Create a new **Web Service** or **Static Site** on Render.
2. Configure:
   *   **Root Directory:** `packages/web`
   *   **Build Command:** `pnpm install --frozen-lockfile && pnpm --filter @bugbuddy/shared build && pnpm run build`
   *   **Start Command:** `pnpm start`
3. Add **Environment Variables**:
   *   `NEXT_PUBLIC_API_URL`: `https://your-backend-api-domain.com` (Your Render API URL)
