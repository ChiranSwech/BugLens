# BugBuddy — Task Tracker

## Phase 0 — Monorepo Scaffold & Infrastructure
- [x] Root `package.json` (pnpm workspaces)
- [x] `pnpm-workspace.yaml`
- [x] `turbo.json`
- [x] `.gitignore`, `.eslintrc.js`, `.prettierrc`
- [x] `docker-compose.yml` (production on-prem)
- [x] `docker-compose.dev.yml` (dev hot-reload)
- [x] `.env.example`
- [x] `nginx/nginx.conf` (TLS termination, reverse proxy)
- [ ] `README.md` (pending)

## Phase 1 — Shared Package (`packages/shared`)
- [x] `package.json`, `tsconfig.json`
- [x] `src/schemas/bug.ts` — includes `AttachmentData`, `NetworkLog`, `CreateBug`
- [x] `src/schemas/session.ts`
- [x] `src/schemas/user.ts`
- [x] `src/schemas/attachment.ts`
- [x] `src/schemas/index.ts`
- [x] `src/crypto/hmac.ts`
- [x] `src/crypto/phash.ts`
- [x] `src/index.ts`

## Phase 2 — Backend (`packages/backend`)
- [x] `package.json`, `tsconfig.json`, `Dockerfile`
- [x] `src/config.ts`
- [x] `src/app.ts`
- [x] `src/server.ts`
- [x] `db/init.sql` (all tables)
- [x] `db/001_add_network_logs_and_hover.sql` (migration)
- [x] `src/db/pool.ts`
- [x] `src/auth/routes.ts`
- [x] `src/auth/jwt.ts`
- [x] `src/auth/refresh.ts`
- [x] `src/middleware/authenticate.ts`
- [x] `src/middleware/authorize.ts`
- [x] `src/middleware/audit.ts`
- [x] `src/middleware/validate.ts`
- [x] `src/bugs/routes.ts` — creates bug + persists screenshots to MinIO + network logs
- [x] `src/sessions/routes.ts`
- [x] `src/uploads/routes.ts`
- [x] `src/workers/pii-redaction.ts`
- [x] `src/workers/integration-dispatch.ts`
- [x] `src/workers/runner.ts`
- [x] `src/integrations/adapter.ts`
- [x] `src/integrations/jira.ts`
- [ ] Integration API routes wired (`/v1/integrations/*`)
- [ ] BullMQ queue connected to worker runner

## Phase 3 — Chrome Extension (`packages/extension`)
- [x] `public/manifest.json` (MV3, `downloads` permission added)
- [x] `src/background/index.ts`
- [x] `src/content/index.ts`
- [x] `src/popup/popup.tsx` + css + html
- [x] `src/sidepanel/SidePanel.tsx` + css + html
- [x] `src/devtools/index.html` (fixed — now loads devtools.js)
- [x] `src/devtools/devtools.ts` (registers DevTools panel)
- [x] `src/devtools/panel.html` (full network monitor panel UI)
- [x] `src/shared/api.ts` (typed API client)

## Phase 4 — Web Dashboard (`packages/web`) — v1.x
- [x] Next.js 14 App Router scaffold
- [x] Bug list page
- [ ] Bug detail + replay page (`/bugs/[id]`)
- [ ] Analytics page
- [ ] Settings page (integrations, templates, users)
- [ ] Audit log viewer (admin)

## Phase 5 — Revamp Integrations & Reports
- [x] Remove global "Submit Bug Report" button from sidepanel footer
- [x] Redesign integration cards into beautiful collapsible headers with arrows
- [x] Add inline direct dispatch buttons, loading states, and result banners
- [x] Display steps summary formatted on individual lines in HTML export
- [x] Fix overlap of copy icon inside steps summary card using top-right positioning
- [x] Escape template strings in HTML reports for error-free build compilation
- [x] Star badge selection of main screenshot image shown under defect description

## Remaining Issues
- [ ] `popup.tsx` / `SidePanel.tsx` — migrate to `src/shared/api.ts` typed client
- [x] BullMQ queue wired into backend (workers defined and enqueued in routes)
- [ ] Extension Vite build entry: add `devtools.ts` as a build entry point
- [ ] Web dashboard: use `sessionStorage` instead of `localStorage` for token
- [ ] README.md
