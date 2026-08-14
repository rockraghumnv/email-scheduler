# Email Scheduler

LiveURL : http://4.240.106.62.sslip.io/login

demo_video : https://drive.google.com/file/d/1YW3oRR30mZ1TZ0P3hNd4IG8ZkP5KDl0b/view?usp=drivesdk

A full-stack service for scheduling and sending bulk email campaigns, with delayed delivery, per-sender rate limiting, and retry handling. Built with React + TypeScript on the frontend and Express + TypeScript, PostgreSQL/Prisma, and BullMQ/Redis on the backend, sending through Ethereal SMTP for development/testing.

## Architecture

```text
React
  ↓
Express API
  ├── PostgreSQL
  └── BullMQ
        ↓
      Redis
        ↓
   Worker 1 / Worker 2
        ↓
   Ethereal SMTP
```

- **PostgreSQL** → durable application/business data (users, senders, campaigns, emails)
- **BullMQ** → background and delayed job management
- **Redis** → BullMQ state and distributed rate-limit coordination across workers
- **Workers** → separate processes that execute email jobs (send via SMTP, update state)
- **Ethereal** → fake SMTP provider used for delivery/testing (no real emails sent)

## Features

- Google OAuth authentication (with email/password as a fallback)
- Multiple sender identities per user
- Campaign scheduling with per-recipient timing
- CSV/text recipient upload with client-side validation and de-duplication
- BullMQ delayed jobs
- Configurable worker concurrency
- Multiple worker processes consuming the same queue
- Minimum send delay per sender
- Hourly rate limiting per sender
- Redis-backed distributed coordination (rate limiting is correct across multiple workers, not per-process)
- Retry handling with exponential backoff and permanent-vs-transient failure classification
- Idempotency protections (deterministic job IDs, atomic status claims, no double-send)
- Scheduled emails dashboard
- Sent/failed emails dashboard
- Restart persistence (jobs survive API/worker restarts)

## Project Structure

```text
backend/
├── src/
│   ├── routes/        # Express route definitions
│   ├── controllers/   # Request handling + validation
│   ├── services/      # Business logic (campaigns, emails, rate limiting, SMTP)
│   ├── queue/         # BullMQ queue + worker
│   ├── middleware/     # Session auth guard
│   └── lib/            # Prisma client, Redis clients
├── prisma/             # Schema, migrations, dev seed script
└── tests/              # node:test suite

frontend/
├── src/
│   ├── pages/          # Login, Dashboard
│   ├── components/     # ComposeModal (campaign creation + CSV upload)
│   └── services/       # Typed API clients (axios)
└── ...

infra/
└── docker-compose.yml  # Local PostgreSQL + Redis
```

## Local Setup

```bash
# 1. Clone repository
git clone <repo-url>
cd email-scheduler

# 2. Start PostgreSQL + Redis
docker compose -f infra/docker-compose.yml up -d

# 3. Backend
cd backend
npm install
cp .env.example .env   # fill in values — see Environment Variables below
npx prisma migrate dev
npm run dev             # starts the API on PORT (default 4000)

# 4. Worker(s) — each in its own terminal
npm run worker          # Worker 1
npm run worker          # Worker 2 (optional, demonstrates multi-worker consumption)

# 5. Frontend
cd ../frontend
npm install
cp .env.example .env   # set VITE_API_URL
npm run dev
```

There is no sender-creation endpoint yet — after your first Google login, run `npx prisma db seed` from `backend/` to provision a dev sender for that account.

## Environment Variables

Backend (`backend/.env`):

```env
PORT=
FRONTEND_URL=
DATABASE_URL=
REDIS_HOST=
REDIS_PORT=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_CALLBACK_URL=
SESSION_SECRET=
ETHEREAL_HOST=
ETHEREAL_PORT=
ETHEREAL_USER=
ETHEREAL_PASSWORD=
ETHEREAL_SECURE=
MIN_EMAIL_DELAY=
MAX_EMAILS_PER_HOUR=
WORKER_CONCURRENCY=
EMAIL_JOB_ATTEMPTS=
EMAIL_RETRY_BACKOFF_MS=
```

Frontend (`frontend/.env`):

```env
VITE_API_URL=
```

`.env` files are gitignored and must never be committed — only `.env.example` (names, no values) belongs in version control.

## How Scheduling Works

```text
User schedules campaign
        ↓
PostgreSQL stores campaign/email records
        ↓
BullMQ creates delayed jobs
        ↓
Redis stores/manages job state
        ↓
Workers process jobs
        ↓
Rate limiting decides whether sending is allowed
        ↓
Ethereal SMTP
        ↓
PostgreSQL updated with sent/failed state
```

`POST /api/campaigns` commits the campaign and its emails to PostgreSQL, enqueues the corresponding BullMQ jobs, and returns immediately — it does not wait for any email to actually be sent. Sending happens later and asynchronously, whenever a worker picks up each job and the rate limiter allows it.

## Concurrency & Rate Limiting

- Worker concurrency (jobs a single worker process may handle at once) is configured via `WORKER_CONCURRENCY` (default `3`).
- Running multiple worker processes (e.g. two, one per terminal) is supported and was used to demonstrate distributed processing — see Testing below.
- **Minimum delay**: enforced per sender via an atomic Redis Lua script checking that sender's last-send timestamp; a job attempted too soon is deferred (re-delayed in BullMQ) rather than sent.
- **Hourly limit**: enforced per sender via a Redis counter keyed to the current UTC hour; once a sender's count for that hour reaches its campaign's `hourlyLimit`, further jobs for that sender are deferred to the start of the next UTC hour.
- Both checks run through the same atomic Lua script against shared Redis state, so the limits hold correctly across multiple worker processes, not just within one.
- When the hourly limit is reached, affected emails are **not dropped or marked failed** — they stay in `scheduled` status and their BullMQ job is rescheduled for the next hour.

## Persistence & Restart

- PostgreSQL holds the durable business state (campaign/email records, status, timestamps) — the source of truth.
- Redis/BullMQ independently holds job scheduling state (delayed/waiting/active/completed).
- Delayed jobs survive a full restart of both the API and worker processes: this was verified by stopping both, confirming the jobs still existed in Redis, restarting, and observing them process once due.
- Jobs are not recreated from scratch after a restart — each email's BullMQ job uses a deterministic ID, so re-running scheduling logic is a safe no-op rather than a duplicate.

## API Endpoints

| Method | Endpoint                    | Purpose                                  |
| ------ | ---------------------------- | ----------------------------------------- |
| POST   | `/api/auth/register`         | Create a password-based account           |
| POST   | `/api/auth/login`            | Log in with email/password                |
| GET    | `/api/auth/google`           | Start Google OAuth login                  |
| GET    | `/api/auth/google/callback`  | Google OAuth callback                     |
| POST   | `/api/auth/logout`           | Logout                                    |
| GET    | `/api/auth/me`               | Current authenticated user                |
| GET    | `/api/senders`               | User's sender identities                  |
| POST   | `/api/campaigns`             | Create and schedule a campaign            |
| GET    | `/api/campaigns`             | List user's campaigns (paginated)         |
| GET    | `/api/emails/scheduled`      | Scheduled/processing emails (paginated)   |
| GET    | `/api/emails/sent`           | Sent/failed emails (paginated)            |

All endpoints except register/login/Google routes require an authenticated session; every query is scoped to the logged-in user.
## Assumptions & Trade-offs

* **Two workers:** Used to demonstrate concurrent processing and shared Redis rate limiting; worker count/concurrency are configurable.
* **Sender seeding:** Senders are created through a Prisma seed script since sender onboarding is outside the assignment.
* **Limits:** Delay and hourly limit are campaign-level UI settings, while env values define system boundaries/defaults.
* **Ethereal:** Nodemailer uses a programmatically created Ethereal test account; credentials are stored in `.env`.
* **Rate limiting:** When the hourly limit is reached, jobs are delayed to the next available hour instead of being dropped.
* **Idempotency:** Each email has a unique/deterministic job ID and its status is checked before sending. If SMTP accepts the email and the worker crashes before recording `sent` in PostgreSQL, exactly-once delivery cannot be guaranteed with ordinary SMTP.
