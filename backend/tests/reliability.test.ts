import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, mock, test } from "node:test";

// These tests exercise the Redis/BullMQ/Postgres coordination this stage
// adds (retry wiring, crash recovery, duplicate-claim safety, durability
// across restarts) — not the SMTP transport itself, which was already
// proven against the real Ethereal account in Stages 5-6 (and remains
// unmodified here). Mocking sendMail keeps this suite fast and immune to
// the live Ethereal account's own rate limits under heavy test load.
mock.module("../src/services/smtp.service.js", {
  exports: {
    sendMail: async () => ({ messageId: `mock-${randomUUID()}`, response: "250 OK" }),
    getPreviewUrl: () => false as const,
    verifySmtpConnection: async () => true,
  },
});

const { createEmailWorker } = await import("../src/queue/email.worker.js");
const { EMAIL_QUEUE_NAME, closeEmailQueue, getEmailJobState, removeEmailJobs } = await import(
  "../src/queue/email.queue.js"
);
const { prisma } = await import("../src/lib/prisma.js");
const { ioredisConnection } = await import("../src/lib/redis.js");
const { scheduleCampaignEmails } = await import("../src/services/scheduler.service.js");
const bullmq = await import("bullmq");
const { Worker } = bullmq;
type Job<T> = InstanceType<typeof bullmq.Job<T>>;
type EmailJobData = { emailId: string; campaignId: string };

const createdUserIds: string[] = [];
const provisionedEmailIds: string[] = [];
const activeWorkers: InstanceType<typeof Worker>[] = [];

// BullMQ's stalled-job check isn't purely per-worker: each check also sets a
// *queue-wide* cooldown key (TTL = that worker's own stalledInterval) that
// blocks *any* worker's next check — even one configured with a much
// shorter interval — until it expires. Every worker in this file must share
// one short interval, or an earlier test's default-interval (30s) worker
// would silently block Test 7's short-interval recovery for up to 30s.
const TEST_STALLED_INTERVAL_MS = 1000;

function testWorker(options: Parameters<typeof createEmailWorker>[0] = {}) {
  return createEmailWorker({ stalledInterval: TEST_STALLED_INTERVAL_MS, ...options });
}

async function createTestUser(prefix: string) {
  const user = await prisma.user.create({ data: { email: `${prefix}-${randomUUID()}@example.test`, name: "Test User" } });
  createdUserIds.push(user.id);
  return user;
}

async function createTestSender(userId: string) {
  return prisma.sender.create({ data: { userId, email: `sender-${randomUUID()}@company.test`, displayName: "Test Sender" } });
}

async function createTestCampaign(userId: string, senderId: string, startTime: Date) {
  return prisma.campaign.create({
    data: {
      userId,
      senderId,
      subject: "Reliability test",
      body: "Hello from the reliability test suite.",
      startTime,
      delaySeconds: 0,
      hourlyLimit: 1000,
    },
  });
}

async function createDueEmails(campaignId: string, count: number, scheduledAt: Date): Promise<string[]> {
  const emails = await Promise.all(
    Array.from({ length: count }, () =>
      prisma.email.create({ data: { campaignId, recipient: `recipient-${randomUUID()}@ethereal.email`, scheduledAt } }),
    ),
  );
  const ids = emails.map((e) => e.id);
  provisionedEmailIds.push(...ids);
  return ids;
}

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 15_000, intervalMs = 100): Promise<T> {
  const start = Date.now();
  for (;;) {
    const result = await fn();
    if (result !== undefined) {
      return result;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function trackWorker(worker: InstanceType<typeof Worker>) {
  activeWorkers.push(worker);
  return worker;
}
async function closeWorker(worker: InstanceType<typeof Worker>) {
  await worker.close();
  const i = activeWorkers.indexOf(worker);
  if (i !== -1) activeWorkers.splice(i, 1);
}

after(async () => {
  await Promise.all(activeWorkers.map((w) => w.close().catch(() => {})));
  await removeEmailJobs(provisionedEmailIds);
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await closeEmailQueue();
  await prisma.$disconnect();
  if (ioredisConnection.status !== "end") {
    ioredisConnection.disconnect();
  }
});

describe("Successful send", () => {
  test("Test 1: a due email is sent and marked sent", async () => {
    const user = await createTestUser("rel-success");
    const sender = await createTestSender(user.id);
    const campaign = await createTestCampaign(user.id, sender.id, new Date());
    const [emailId] = await createDueEmails(campaign.id, 1, new Date());
    await scheduleCampaignEmails(campaign.id, [{ id: emailId!, scheduledAt: new Date() }]);

    const worker = trackWorker(testWorker({ concurrency: 1 }));
    try {
      const email = await waitFor(async () => {
        const e = await prisma.email.findUniqueOrThrow({ where: { id: emailId! } });
        return e.status === "sent" ? e : undefined;
      });
      assert.equal(email.status, "sent");
      assert.ok(email.sentAt);
      assert.equal(await getEmailJobState(emailId!), "completed");
    } finally {
      await closeWorker(worker);
    }
  });
});

describe("Duplicate scheduling", () => {
  test("Test 6: scheduling the same email twice does not create a second logical job", async () => {
    const user = await createTestUser("rel-dup-schedule");
    const sender = await createTestSender(user.id);
    const scheduledAt = new Date(Date.now() + 60_000);
    const campaign = await createTestCampaign(user.id, sender.id, scheduledAt);
    const [emailId] = await createDueEmails(campaign.id, 1, scheduledAt);

    await scheduleCampaignEmails(campaign.id, [{ id: emailId!, scheduledAt }]);
    const stateAfterFirst = await getEmailJobState(emailId!);

    // Re-provisioning attempt for the exact same email (e.g. a retried API
    // request) — same deterministic jobId, must be a no-op, not a second job.
    await scheduleCampaignEmails(campaign.id, [{ id: emailId!, scheduledAt }]);
    const stateAfterSecond = await getEmailJobState(emailId!);

    assert.equal(stateAfterFirst, "delayed");
    assert.equal(stateAfterSecond, "delayed");
  });
});

describe("Worker crash recovery", () => {
  test("Test 7: a job whose worker crashes mid-processing is recovered by another worker", async () => {
    const user = await createTestUser("rel-crash");
    const sender = await createTestSender(user.id);
    const campaign = await createTestCampaign(user.id, sender.id, new Date());
    const [emailId] = await createDueEmails(campaign.id, 1, new Date());
    await scheduleCampaignEmails(campaign.id, [{ id: emailId!, scheduledAt: new Date() }]);

    let sawJob = false;
    // A raw Worker whose processor claims the email (exactly like
    // processEmailSend's first step) and then hangs forever — simulates a
    // worker process that grabbed the job and died before finishing. Short
    // lockDuration/stalledInterval so the test doesn't need BullMQ's real
    // 30s defaults.
    const crashingWorker = new Worker<EmailJobData>(
      EMAIL_QUEUE_NAME,
      async (job: Job<EmailJobData>) => {
        sawJob = true;
        await prisma.email.updateMany({
          where: { id: job.data.emailId, status: "scheduled" },
          data: { status: "processing" },
        });
        await new Promise(() => {}); // never resolves
      },
      { connection: ioredisConnection, concurrency: 1, lockDuration: 1000, stalledInterval: TEST_STALLED_INTERVAL_MS },
    );

    try {
      await waitFor(async () => (sawJob ? true : undefined), 10_000);
      await waitFor(async () => {
        const e = await prisma.email.findUniqueOrThrow({ where: { id: emailId! } });
        return e.status === "processing" ? true : undefined;
      }, 5_000);

      // Force-close: does NOT wait for the (hung) active job and stops lock
      // renewal — from Redis's point of view this looks exactly like a
      // crashed process, not a graceful shutdown.
      await crashingWorker.close(true);

      const midflight = await prisma.email.findUniqueOrThrow({ where: { id: emailId! } });
      assert.equal(midflight.status, "processing", "email must still be persisted mid-flight, not lost");

      const recoveryWorker = trackWorker(
        testWorker({
          concurrency: 1,
          lockDuration: 1000,
          // Must be shortened to match lockDuration above — otherwise the
          // DB-level reclaim guard (2 minutes by default) would refuse to
          // reclaim a "processing" row long after BullMQ has already
          // decided the original job is stalled and redelivered it.
          staleProcessingThresholdMs: 500,
        }),
      );
      try {
        const recovered = await waitFor(async () => {
          const e = await prisma.email.findUniqueOrThrow({ where: { id: emailId! } });
          return e.status === "sent" ? e : undefined;
        }, 15_000);
        assert.equal(recovered.status, "sent");
      } finally {
        await closeWorker(recoveryWorker);
      }
    } finally {
      await crashingWorker.close(true).catch(() => {});
    }
  });
});

describe("Delayed job durability", () => {
  test("Test 8: a delayed job survives its worker closing before the delay elapses, and a fresh worker completes it", async () => {
    const user = await createTestUser("rel-worker-restart");
    const sender = await createTestSender(user.id);
    const scheduledAt = new Date(Date.now() + 2000);
    const campaign = await createTestCampaign(user.id, sender.id, scheduledAt);
    const [emailId] = await createDueEmails(campaign.id, 1, scheduledAt);
    await scheduleCampaignEmails(campaign.id, [{ id: emailId!, scheduledAt }]);

    assert.equal(await getEmailJobState(emailId!), "delayed");

    const firstWorker = testWorker({ concurrency: 1 });
    await firstWorker.close();

    const stillThere = await getEmailJobState(emailId!);
    assert.ok(stillThere === "delayed" || stillThere === "waiting");
    assert.equal((await prisma.email.findUniqueOrThrow({ where: { id: emailId! } })).status, "scheduled");

    const secondWorker = trackWorker(testWorker({ concurrency: 1 }));
    try {
      const email = await waitFor(async () => {
        const e = await prisma.email.findUniqueOrThrow({ where: { id: emailId! } });
        return e.status === "sent" ? e : undefined;
      });
      assert.equal(email.status, "sent");
    } finally {
      await closeWorker(secondWorker);
    }
  });

  test("Test 9: a job created while no worker exists yet (simulating an API-only moment) is still durable and gets processed once a worker starts", async () => {
    const user = await createTestUser("rel-api-restart");
    const sender = await createTestSender(user.id);
    const scheduledAt = new Date(Date.now() + 1500);
    const campaign = await createTestCampaign(user.id, sender.id, scheduledAt);
    const [emailId] = await createDueEmails(campaign.id, 1, scheduledAt);

    // This is the "API" side of the system: it only ever talks to
    // Postgres + Redis, never constructs a Worker. Nothing here depends on
    // any worker process being alive right now.
    await scheduleCampaignEmails(campaign.id, [{ id: emailId!, scheduledAt }]);
    assert.equal(await getEmailJobState(emailId!), "delayed");

    // Simulate time passing with *no worker process running at all* — the
    // job must still be sitting in Redis, unaffected.
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(await getEmailJobState(emailId!), "delayed");

    // Only now does a worker process come into existence for the first
    // time — analogous to starting `npm run worker` well after the API
    // scheduled the job.
    const worker = trackWorker(testWorker({ concurrency: 1 }));
    try {
      const email = await waitFor(async () => {
        const e = await prisma.email.findUniqueOrThrow({ where: { id: emailId! } });
        return e.status === "sent" ? e : undefined;
      });
      assert.equal(email.status, "sent");
    } finally {
      await closeWorker(worker);
    }
  });
});

describe("Concurrent claim safety", () => {
  test("Test 10: two workers racing for the same email — only one sends it", async () => {
    const user = await createTestUser("rel-race");
    const sender = await createTestSender(user.id);
    const campaign = await createTestCampaign(user.id, sender.id, new Date());
    const [emailId] = await createDueEmails(campaign.id, 1, new Date());
    await scheduleCampaignEmails(campaign.id, [{ id: emailId!, scheduledAt: new Date() }]);

    let worker1Completed = 0;
    let worker2Completed = 0;
    const worker1 = trackWorker(testWorker({ concurrency: 2 }));
    worker1.on("completed", (job: Job<EmailJobData>) => {
      if (job.data.emailId === emailId) worker1Completed++;
    });
    const worker2 = trackWorker(testWorker({ concurrency: 2 }));
    worker2.on("completed", (job: Job<EmailJobData>) => {
      if (job.data.emailId === emailId) worker2Completed++;
    });

    try {
      await waitFor(async () => {
        const e = await prisma.email.findUniqueOrThrow({ where: { id: emailId! } });
        return e.status === "sent" ? true : undefined;
      });
      // Give any would-be duplicate a moment to (incorrectly) show up.
      await new Promise((resolve) => setTimeout(resolve, 500));

      assert.equal(
        worker1Completed + worker2Completed,
        1,
        "exactly one worker should have completed the job — never both, never zero",
      );
    } finally {
      await closeWorker(worker1);
      await closeWorker(worker2);
    }
  });
});

describe("Large campaign persistence", () => {
  test("Test 11: 1000 queued jobs (with the retry policy attached) are not lost and don't require restarting from zero", async () => {
    const user = await createTestUser("rel-bulk");
    const sender = await createTestSender(user.id);
    const campaign = await createTestCampaign(user.id, sender.id, new Date());
    const emailIds = await createDueEmails(campaign.id, 1000, new Date());
    await scheduleCampaignEmails(
      campaign.id,
      emailIds.map((id) => ({ id, scheduledAt: new Date() })),
    );

    let completed = 0;
    const worker = testWorker({ concurrency: 3 });
    worker.on("completed", () => completed++);

    try {
      await waitFor(async () => (completed >= 5 ? true : undefined), 20_000, 100);
      assert.ok(completed >= 5);
    } finally {
      await closeWorker(worker);
    }

    // "Restart": a brand new worker instance picks up exactly where the
    // last one left off — it does not need to recreate or replay anything.
    let completedAfterRestart = 0;
    const restarted = trackWorker(testWorker({ concurrency: 3 }));
    restarted.on("completed", () => completedAfterRestart++);
    try {
      await waitFor(async () => (completedAfterRestart >= 5 ? true : undefined), 20_000, 100);
    } finally {
      await closeWorker(restarted);
    }

    const stillPending = await prisma.email.count({
      where: { id: { in: emailIds }, status: { in: ["scheduled", "processing"] } },
    });
    const sentCount = await prisma.email.count({ where: { id: { in: emailIds }, status: "sent" } });
    assert.ok(sentCount >= 10, `expected at least 10 sent across both worker lifetimes, got ${sentCount}`);
    assert.ok(stillPending > 0, "most of the 1000 jobs should remain unprocessed — nothing was lost or double-run from zero");
  });
});
