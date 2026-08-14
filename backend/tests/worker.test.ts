import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import type { Worker } from "bullmq";
import { createEmailWorker } from "../src/queue/email.worker.js";
import { closeEmailQueue, getEmailJobState, removeEmailJobs } from "../src/queue/email.queue.js";
import { prisma } from "../src/lib/prisma.js";
import { ioredisConnection } from "../src/lib/redis.js";
import { scheduleCampaignEmails } from "../src/services/scheduler.service.js";
import { processEmailSend } from "../src/services/email.service.js";

// BullMQ's stalled-job check sets a *queue-wide* cooldown key (TTL = the
// checking worker's own stalledInterval) that blocks any worker's next
// check on this queue — even one in a different test file/process with a
// much shorter interval. A worker here left at BullMQ's 30s default can
// silently block reliability.test.ts's short-interval crash-recovery test
// for up to 30s when both run concurrently. Match that shared short
// interval here even though nothing in this file itself depends on it.
const TEST_STALLED_INTERVAL_MS = 1000;

function testWorker(options: Parameters<typeof createEmailWorker>[0] = {}) {
  return createEmailWorker({ stalledInterval: TEST_STALLED_INTERVAL_MS, ...options });
}

const createdUserIds: string[] = [];
const provisionedEmailIds: string[] = [];
const activeWorkers: Worker[] = [];

async function createTestUser(prefix: string) {
  const user = await prisma.user.create({
    data: { email: `${prefix}-${randomUUID()}@example.test`, name: "Test User" },
  });
  createdUserIds.push(user.id);
  return user;
}

async function createTestSender(userId: string) {
  return prisma.sender.create({
    data: { userId, email: `sender-${randomUUID()}@company.test`, displayName: "Test Sender" },
  });
}

async function createTestCampaign(userId: string, senderId: string, startTime: Date) {
  return prisma.campaign.create({
    data: {
      userId,
      senderId,
      subject: "Worker test",
      body: "Hello from the worker test suite.",
      startTime,
      delaySeconds: 1,
      hourlyLimit: 100,
    },
  });
}

async function createDueEmails(campaignId: string, count: number, scheduledAt: Date): Promise<string[]> {
  const emails = await Promise.all(
    Array.from({ length: count }, () =>
      prisma.email.create({
        data: { campaignId, recipient: `recipient-${randomUUID()}@ethereal.email`, scheduledAt },
      }),
    ),
  );
  const ids = emails.map((e) => e.id);
  provisionedEmailIds.push(...ids);
  return ids;
}

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 20_000, intervalMs = 150): Promise<T> {
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

function trackWorker(worker: Worker): Worker {
  activeWorkers.push(worker);
  return worker;
}

async function closeWorker(worker: Worker): Promise<void> {
  await worker.close();
  const index = activeWorkers.indexOf(worker);
  if (index !== -1) {
    activeWorkers.splice(index, 1);
  }
}

before(async () => {
  // Nothing to connect explicitly here: BullMQ's Queue/Worker manage the
  // shared lazyConnect ioredis connection themselves once constructed.
});

after(async () => {
  await Promise.all(activeWorkers.map((w) => w.close()));
  await removeEmailJobs(provisionedEmailIds);
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await closeEmailQueue();
  await prisma.$disconnect();
  if (ioredisConnection.status !== "end") {
    ioredisConnection.disconnect();
  }
});

describe("Worker: end-to-end send", () => {
  test("Test 1: one due job is picked up, sent through Ethereal, and marked sent in Postgres", async () => {
    const user = await createTestUser("worker-one");
    const sender = await createTestSender(user.id);
    const campaign = await createTestCampaign(user.id, sender.id, new Date());
    const [emailId] = await createDueEmails(campaign.id, 1, new Date());
    await scheduleCampaignEmails(campaign.id, [{ id: emailId!, scheduledAt: new Date() }]);

    const worker = trackWorker(testWorker({ concurrency: 1 }));
    try {
      const sentEmail = await waitFor(async () => {
        const email = await prisma.email.findUniqueOrThrow({ where: { id: emailId! } });
        if (email.status === "failed") {
          throw new Error(`email failed: ${email.failureReason}`);
        }
        return email.status === "sent" ? email : undefined;
      });

      assert.equal(sentEmail.status, "sent");
      assert.ok(sentEmail.sentAt);
      assert.equal(sentEmail.failedAt, null);
      assert.equal(sentEmail.failureReason, null);

      assert.equal(await getEmailJobState(emailId!), "completed");
    } finally {
      await closeWorker(worker);
    }
  });

  test("Test 2: five due jobs all complete with one worker at concurrency 3", async () => {
    const user = await createTestUser("worker-five");
    const sender = await createTestSender(user.id);
    const campaign = await createTestCampaign(user.id, sender.id, new Date());
    const emailIds = await createDueEmails(campaign.id, 5, new Date());
    await scheduleCampaignEmails(
      campaign.id,
      emailIds.map((id) => ({ id, scheduledAt: new Date() })),
    );

    const worker = trackWorker(testWorker({ concurrency: 3 }));
    try {
      await waitFor(async () => {
        const rows = await prisma.email.findMany({ where: { id: { in: emailIds } } });
        const unresolved = rows.filter((r) => r.status !== "sent" && r.status !== "failed");
        return unresolved.length === 0 ? true : undefined;
      });

      const final = await prisma.email.findMany({ where: { id: { in: emailIds } } });
      assert.equal(final.length, 5);
      assert.ok(final.every((e) => e.status === "sent"));
    } finally {
      await closeWorker(worker);
    }
  });
});

describe("Worker: two processes share one queue", () => {
  test("Test 3: jobs are distributed across two worker instances, not all handled by one", async () => {
    const user = await createTestUser("worker-two-procs");
    const sender = await createTestSender(user.id);
    const campaign = await createTestCampaign(user.id, sender.id, new Date());
    const emailIds = await createDueEmails(campaign.id, 6, new Date());
    await scheduleCampaignEmails(
      campaign.id,
      emailIds.map((id) => ({ id, scheduledAt: new Date() })),
    );

    let worker1Count = 0;
    let worker2Count = 0;

    const worker1 = trackWorker(testWorker({ concurrency: 2 }));
    worker1.on("completed", () => worker1Count++);
    const worker2 = trackWorker(testWorker({ concurrency: 2 }));
    worker2.on("completed", () => worker2Count++);

    try {
      await waitFor(async () => {
        const rows = await prisma.email.findMany({ where: { id: { in: emailIds } } });
        const unresolved = rows.filter((r) => r.status !== "sent" && r.status !== "failed");
        return unresolved.length === 0 ? true : undefined;
      });

      assert.ok(worker1Count > 0, "worker 1 should have completed at least one job");
      assert.ok(worker2Count > 0, "worker 2 should have completed at least one job");
      assert.equal(worker1Count + worker2Count, 6);
    } finally {
      await closeWorker(worker1);
      await closeWorker(worker2);
    }
  });
});

describe("Worker: invalid / missing data", () => {
  test("Test 4a: processEmailSend rejects for a nonexistent email id without attempting to send", async () => {
    await assert.rejects(
      processEmailSend(randomUUID()),
      (err: unknown) => (err as { statusCode?: number }).statusCode === 404,
    );
  });

  test("Test 4b: a queued job for a nonexistent email id fails rather than hanging or succeeding", async () => {
    const user = await createTestUser("worker-invalid");
    const sender = await createTestSender(user.id);
    const campaign = await createTestCampaign(user.id, sender.id, new Date());
    const fakeEmailId = randomUUID();
    provisionedEmailIds.push(fakeEmailId);
    await scheduleCampaignEmails(campaign.id, [{ id: fakeEmailId, scheduledAt: new Date() }]);

    const worker = trackWorker(testWorker({ concurrency: 1 }));
    try {
      await waitFor(async () => {
        const state = await getEmailJobState(fakeEmailId);
        return state === "failed" ? true : undefined;
      });
      assert.equal(await getEmailJobState(fakeEmailId), "failed");
    } finally {
      await closeWorker(worker);
    }
  });
});

describe("Worker: restart", () => {
  test("Test 6: a delayed job survives a worker being closed and started again", async () => {
    const user = await createTestUser("worker-restart");
    const sender = await createTestSender(user.id);
    const scheduledAt = new Date(Date.now() + 2000);
    const campaign = await createTestCampaign(user.id, sender.id, scheduledAt);
    const [emailId] = await createDueEmails(campaign.id, 1, scheduledAt);
    await scheduleCampaignEmails(campaign.id, [{ id: emailId!, scheduledAt }]);

    assert.equal(await getEmailJobState(emailId!), "delayed");

    const firstWorker = testWorker({ concurrency: 1 });
    await firstWorker.close();

    // Job must still be sitting in Redis, untouched, after the worker closed
    // before the delay even elapsed.
    const stillThere = await getEmailJobState(emailId!);
    assert.ok(stillThere === "delayed" || stillThere === "waiting");
    const email = await prisma.email.findUniqueOrThrow({ where: { id: emailId! } });
    assert.equal(email.status, "scheduled");

    const secondWorker = trackWorker(testWorker({ concurrency: 1 }));
    try {
      await waitFor(async () => {
        const e = await prisma.email.findUniqueOrThrow({ where: { id: emailId! } });
        return e.status === "sent" ? true : undefined;
      });
      assert.equal(await getEmailJobState(emailId!), "completed");
    } finally {
      await closeWorker(secondWorker);
    }
  });
});

describe("Worker: large campaign", () => {
  test("Test 7: 1000 queued jobs are consumable without requiring all 1000 to be delivered", async () => {
    const user = await createTestUser("worker-bulk");
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
      // Only prove the pipeline works at this scale — not that all 1000 get
      // delivered. A handful of real completions plus a large remaining
      // backlog is sufficient evidence the queue/worker mechanism scales.
      await waitFor(async () => (completed >= 5 ? true : undefined), 20_000, 100);
      assert.ok(completed >= 5);
    } finally {
      await closeWorker(worker);
    }

    const stillPending = await prisma.email.count({
      where: { id: { in: emailIds }, status: { in: ["scheduled", "processing"] } },
    });
    assert.ok(stillPending > 0, "most of the 1000 jobs should remain unprocessed after closing the worker early");
  });
});
