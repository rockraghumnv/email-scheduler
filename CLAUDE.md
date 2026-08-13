# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project state

This repo is an early-stage scaffold, not a working application yet. There is no backend entry point (no `src/index.ts` or server file exists despite `package.json` naming `index.js` as `main`), the Prisma schema has no models, and the frontend is still the unmodified Vite + React starter template. Treat directories like `backend/src/controllers`, `services`, `models`, `routes`, `middleware`, `queue`, `config`, `utils` as empty placeholders — nothing to grep for there yet.

The project name and the backend's dependencies/env vars indicate the intended product: a bulk/scheduled email sender with Google OAuth (`googleapis`, `GOOGLE_CLIENT_ID/SECRET/CALLBACK_URL`), SMTP sending (`nodemailer`), CSV-based recipient import (`csv-parse`, `multer`), BullMQ + Redis for scheduling/rate-limited send jobs (`WORKER_CONCURRENCY`, `WORKER_COUNT`, `MIN_EMAIL_DELAY`, `MAX_EMAILS_PER_HOUR`), and session-based auth (`express-session` + `connect-redis`). None of this is implemented yet — use it only to understand *where new code should go*, not as a description of existing behavior.

## Repository layout

This is not a single npm workspace — `backend/` and `frontend/` are independent Node projects, each with its own `package.json`/lockfile and no root `package.json`. Always `cd` into the relevant one before running npm commands.

- `backend/` — Express + TypeScript API (dependencies present, implementation not yet started)
- `frontend/` — React 19 + TypeScript + Vite + Tailwind v4 SPA
- `infra/docker-compose.yml` — local Postgres and Redis for backend development

## Local infrastructure

```
cd infra && docker compose up -d
```

Starts Postgres (`postgres:17`) on host port **5433** (mapped from container 5432) and Redis (`redis:8-alpine`) on host port **6380** (mapped from container 6379). These non-default ports mean `DATABASE_URL` and `REDIS_PORT` in `backend/.env` must point at 5433/6380, not the Postgres/Redis defaults.

## Backend (`backend/`)

Stack: Express 5, TypeScript, Prisma 7 (with `@prisma/adapter-pg` driver adapter), BullMQ + ioredis, Zod, googleapis, nodemailer.

No `dev`, `build`, or `lint` scripts are defined in `backend/package.json` yet — only a stub `test` script that exits with an error. When adding real scripts, wire them up in `package.json` (the `tsx` dependency is already present for running TypeScript directly, e.g. `npx tsx src/index.ts`, once an entry point exists).

Prisma specifics for this repo:
- Config lives in `prisma.config.ts` (not `package.json`), using the new Prisma 7 `defineConfig` — schema at `prisma/schema.prisma`, migrations at `prisma/migrations`.
- The generator output is customized to `../generated/prisma` (i.e. `backend/generated/prisma`), not the default `node_modules/@prisma/client` location — import the generated client from that path.
- The client uses the `@prisma/adapter-pg` driver adapter (Prisma 7 requires an explicit driver adapter rather than the legacy built-in connection engine).
- `.env` is not auto-loaded by the Prisma CLI in v7; `prisma.config.ts` explicitly does `import "dotenv/config"` to load `DATABASE_URL`.
- Run migrations with `npx prisma migrate dev` from `backend/`; regenerate the client with `npx prisma generate` after schema changes.
- Consult the `prisma-*` skills (already installed under `backend/.claude/skills`) for CLI, client API, driver adapter, and Postgres setup details rather than re-deriving Prisma 7 behavior from first principles.

Required env vars (see `backend/.env.example`): `DATABASE_URL`, `REDIS_HOST`, `REDIS_PORT`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL`, `SESSION_SECRET`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `WORKER_CONCURRENCY`, `WORKER_COUNT`, `MIN_EMAIL_DELAY`, `MAX_EMAILS_PER_HOUR`. The last four suggest send-rate throttling is meant to be enforced in the BullMQ worker layer (`backend/src/queue`), not the HTTP layer.

## Frontend (`frontend/`)

```
cd frontend
npm run dev       # Vite dev server
npm run build     # tsc -b && vite build
npm run lint      # eslint .
npm run preview   # preview production build
```

Stack: React 19, React Router 7, TanStack Query 5, Tailwind CSS v4 (via `@tailwindcss/vite`), Axios, react-dropzone + papaparse (for the CSV recipient import flow implied by the backend deps), sonner for toasts. No test runner is configured. `App.tsx`/`main.tsx` are still the default Vite template — expect to replace them rather than extend them.
