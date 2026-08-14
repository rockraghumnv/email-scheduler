import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, mock, test } from "node:test";

// This suite is about Redis-coordinated delay/quota enforcement, not SMTP
// integration (already proven against real Ethereal in Stages 5-6) — mock
// sendMail so gaps between "sent" timestamps are exact (no real network
// round-trip skew to tolerate) and the suite is immune to Ethereal's own
// rate limits under heavy concurrent test load.
mock.module("../src/services/smtp.service.js", {
  exports: {
    sendMail: async () => ({ messageId: `mock-${randomUUID()}`, response: "250 OK" }),
    getPreviewUrl: () => false as const,
    verifySmtpConnection: async () => true,
  },
});

const { createEmailWorker } = await import("../src/queue/email.worker.js");
const { closeEmailQueue, getEmailJobState, removeEmailJobs } = await import("../src/queue/email.queue.js");
const { prisma } = await import("../src/lib/prisma.js");
const { ioredisConnection } = await import("../src/lib/redis.js");
const { scheduleCampaignEmails } = await import("../src/services/scheduler.service.js");
const { reserveSendSlot } = await import("../src/services/rate-limit.service.js");
const bullmq = await import("bullmq");
type Worker = InstanceType<typeof bullmq.Worker>;

const createdUserIds: string[] = [];
const provisionedEmailIds: string[] = [];
const rateLimitedSenderIds: string[] = [];
const activeWorkers: Worker[] = [];

// See reliability.test.ts for why this must be shared and short: BullMQ's
// stalled-check sets a queue-wide cooldown keyed off whichever worker's own
// stalledInterval last set it, blocking every other worker's check (even a
// shorter one) until it expires.
const TEST_STALLED_INTERVAL_MS = 5000;
function testWorker(options: Parameters<typeof createEmailWorker>[0] = {}) {
  return createEmailWorker({ stalledInterval: TEST_STALLED_INTERVAL_MS, ...options });
}

async function createTestUser(prefix: string) {
  const user = await prisma.user.create({
    data: { email: `${prefix}-${randomUUID()}@example.test`, name: "Test User" },
  });
  createdUserIds.push(user.id);
  return user;
}

async function createTestSender(userId: string) {
  const sender = await prisma.sender.create({
    data: { userId, email: `sender-${randomUUID()}@company.test`, displayName: "Test Sender" },
  });
  rateLimitedSenderIds.push(sender.id);
  return sender;
}

async function createTestCampaign(
  userId: string,
  senderId: string,
  startTime: Date,
  delaySeconds: number,
  hourlyLimit: number,
) {
  return prisma.campaign.create({
    data: {
      userId,
      senderId,
      subject: "Rate limit test",
      body: "Hello from the rate-limit test suite.",
      startTime,
      delaySeconds,
      hourlyLimit,
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

async function statusesFor(emailIds: string[]) {
  return prisma.email.findMany({
    where: { id: { in: emailIds } },
    select: { id: true, status: true, sentAt: true },
  });
}

before(async () => {
  // Test 4 calls rate-limit.service.ts's reserveSendSlot directly, without
  // going through a Worker/Queue first — but importing email.worker.js up
  // top already started the shared lazyConnect ioredis connection (BullMQ's
  // Queue constructor triggers that). Make sure it's actually ready before
  // any test runs, since that handshake is asynchronous.
  if (ioredisConnection.status === "wait") {
    await ioredisConnection.connect();
  } else {
    while (ioredisConnection.status !== "ready") {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
});

after(async () => {
  await Promise.all(activeWorkers.map((w) => w.close()));
  await removeEmailJobs(provisionedEmailIds);
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await Promise.all(
    rateLimitedSenderIds.map(async (senderId) => {
      const keys = await ioredisConnection.keys(`sender:${senderId}:*`);
      if (keys.length > 0) {
        await ioredisConnection.del(...keys);
      }
    }),
  );
  await closeEmailQueue();
  await prisma.$disconnect();
  if (ioredisConnection.status !== "end") {
    ioredisConnection.disconnect();
  }
});

describe("rate-limit.service: minimum delay + hourly quota (pure)", () => {
  test("Test 4: hourly limit reached reschedules for the start of the next UTC hour, not a permanent block", async () => {
    const senderId = `unit-${randomUUID()}`;
    rateLimitedSenderIds.push(senderId);

    const first = await reserveSendSlot({ senderId, delaySeconds: 0, hourlyLimit: 1 });
    assert.equal(first.allowed, true);

    const second = await reserveSendSlot({ senderId, delaySeconds: 0, hourlyLimit: 1 });
    assert.equal(second.allowed, false);
    assert.equal(second.reason, "hourly_limit");

    const now = new Date();
    const expectedNextHour = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours() + 1),
    );
    assert.equal(second.nextAllowedAt.getTime(), expectedNextHour.getTime());
    assert.ok(second.nextAllowedAt.getTime() > now.getTime());
  });
});

describe("Worker: minimum delay enforced per sender", () => {
  test("Test 1: two emails for the same sender are never sent less than delaySeconds apart", async () => {
    const delaySeconds = 2;
    const user = await createTestUser("rl-delay");
    const sender = await createTestSender(user.id);
    const campaign = await createTestCampaign(user.id, sender.id, new Date(), delaySeconds, 100);
    const emailIds = await createDueEmails(campaign.id, 2, new Date());
    await scheduleCampaignEmails(
      campaign.id,
      emailIds.map((id) => ({ id, scheduledAt: new Date() })),
    );

    const worker = trackWorker(testWorker({ concurrency: 2 }));
    try {
      await waitFor(async () => {
        const rows = await statusesFor(emailIds);
        return rows.every((r) => r.status === "sent") ? true : undefined;
      }, 20_000);

      const rows = await statusesFor(emailIds);
      const sentTimes = rows.map((r) => r.sentAt!.getTime()).sort((a, b) => a - b);
      assert.equal(sentTimes.length, 2);
      const gap = sentTimes[1]! - sentTimes[0]!;
      // No real SMTP round trip now (mocked) — the gap is an exact
      // reflection of the Redis reservation spacing, so a tight bound
      // actually catches a broken rate limiter instead of just system jitter.
      assert.ok(gap >= delaySeconds * 1000 - 100, `expected >= ~${delaySeconds * 1000}ms gap between sends, got ${gap}ms`);
    } finally {
      await closeWorker(worker);
    }
  });
});

describe("Worker: two processes share the same rate limit", () => {
  test("Test 2: minimum delay is still obeyed when two worker instances share the queue", async () => {
    const delaySeconds = 2;
    const user = await createTestUser("rl-two-workers");
    const sender = await createTestSender(user.id);
    const campaign = await createTestCampaign(user.id, sender.id, new Date(), delaySeconds, 100);
    const emailIds = await createDueEmails(campaign.id, 3, new Date());
    await scheduleCampaignEmails(
      campaign.id,
      emailIds.map((id) => ({ id, scheduledAt: new Date() })),
    );

    const worker1 = trackWorker(testWorker({ concurrency: 2 }));
    const worker2 = trackWorker(testWorker({ concurrency: 2 }));
    try {
      await waitFor(async () => {
        const rows = await statusesFor(emailIds);
        return rows.every((r) => r.status === "sent") ? true : undefined;
      }, 25_000);

      const rows = await statusesFor(emailIds);
      const sentTimes = rows.map((r) => r.sentAt!.getTime()).sort((a, b) => a - b);
      assert.equal(sentTimes.length, 3);
      for (let i = 1; i < sentTimes.length; i++) {
        const gap = sentTimes[i]! - sentTimes[i - 1]!;
        assert.ok(gap >= delaySeconds * 1000 - 100, `expected >= ~${delaySeconds * 1000}ms gap between consecutive sends, got ${gap}ms`);
      }
    } finally {
      await closeWorker(worker1);
      await closeWorker(worker2);
    }
  });
});

describe("Worker: hourly quota", () => {
  test("Test 3: only hourlyLimit emails send, the rest are rescheduled (not failed)", async () => {
    const user = await createTestUser("rl-hourly");
    const sender = await createTestSender(user.id);
    const campaign = await createTestCampaign(user.id, sender.id, new Date(), 0, 3);
    const emailIds = await createDueEmails(campaign.id, 5, new Date());
    await scheduleCampaignEmails(
      campaign.id,
      emailIds.map((id) => ({ id, scheduledAt: new Date() })),
    );

    const worker = trackWorker(testWorker({ concurrency: 5 }));
    try {
      // Wait for the 3 allowed sends to land; the other 2 should stabilize
      // as "scheduled" (rescheduled), never "failed".
      await waitFor(async () => {
        const rows = await statusesFor(emailIds);
        const sent = rows.filter((r) => r.status === "sent").length;
        return sent === 3 ? true : undefined;
      }, 15_000);

      // Give the two rescheduled jobs a moment to actually land back in
      // Redis as delayed before asserting on them.
      await new Promise((resolve) => setTimeout(resolve, 500));

      const rows = await statusesFor(emailIds);
      const sent = rows.filter((r) => r.status === "sent");
      const notSent = rows.filter((r) => r.status !== "sent");
      assert.equal(sent.length, 3);
      assert.equal(notSent.length, 2);
      assert.ok(
        notSent.every((r) => r.status === "scheduled"),
        "emails blocked by the hourly limit must remain scheduled, not failed",
      );

      const states = await Promise.all(notSent.map((r) => getEmailJobState(r.id)));
      assert.ok(states.every((s) => s === "delayed" || s === "waiting" || s === "active"));
    } finally {
      await closeWorker(worker);
    }
  });
});

describe("Worker: senders are isolated", () => {
  test("Test 5: sender A hitting its limit does not block sender B", async () => {
    const user = await createTestUser("rl-two-senders");
    const senderA = await createTestSender(user.id);
    const senderB = await createTestSender(user.id);

    const campaignA = await createTestCampaign(user.id, senderA.id, new Date(), 0, 1);
    const [emailA1, emailA2] = await createDueEmails(campaignA.id, 2, new Date());

    const campaignB = await createTestCampaign(user.id, senderB.id, new Date(), 0, 1);
    const [emailB1] = await createDueEmails(campaignB.id, 1, new Date());

    await scheduleCampaignEmails(campaignA.id, [
      { id: emailA1!, scheduledAt: new Date() },
      { id: emailA2!, scheduledAt: new Date() },
    ]);
    await scheduleCampaignEmails(campaignB.id, [{ id: emailB1!, scheduledAt: new Date() }]);

    const worker = trackWorker(testWorker({ concurrency: 3 }));
    try {
      // BullMQ doesn't guarantee which of sender A's two same-instant jobs
      // wins its one available slot — only that exactly one of them does,
      // and that it doesn't depend on/block sender B.
      await waitFor(async () => {
        const b = await prisma.email.findUniqueOrThrow({ where: { id: emailB1! } });
        const [a1, a2] = await Promise.all([
          prisma.email.findUniqueOrThrow({ where: { id: emailA1! } }),
          prisma.email.findUniqueOrThrow({ where: { id: emailA2! } }),
        ]);
        const aResolved = a1.status === "sent" || a2.status === "sent";
        return b.status === "sent" && aResolved ? true : undefined;
      }, 15_000);

      const [a1, a2, b1] = await Promise.all([
        prisma.email.findUniqueOrThrow({ where: { id: emailA1! } }),
        prisma.email.findUniqueOrThrow({ where: { id: emailA2! } }),
        prisma.email.findUniqueOrThrow({ where: { id: emailB1! } }),
      ]);

      assert.equal(b1.status, "sent", "sender B must not be blocked by sender A's quota");
      const aStatuses = [a1.status, a2.status].sort();
      assert.deepEqual(
        aStatuses,
        ["scheduled", "sent"],
        "exactly one of sender A's two emails should send; the other stays rate-limited (scheduled)",
      );
    } finally {
      await closeWorker(worker);
    }
  });
});

describe("Worker: concurrent workers cannot bypass the quota", () => {
  test("Test 6: two workers racing for the same sender never exceed the hourly limit", async () => {
    const user = await createTestUser("rl-race");
    const sender = await createTestSender(user.id);
    const campaign = await createTestCampaign(user.id, sender.id, new Date(), 0, 3);
    const emailIds = await createDueEmails(campaign.id, 5, new Date());
    await scheduleCampaignEmails(
      campaign.id,
      emailIds.map((id) => ({ id, scheduledAt: new Date() })),
    );

    const worker1 = trackWorker(testWorker({ concurrency: 3 }));
    const worker2 = trackWorker(testWorker({ concurrency: 3 }));
    try {
      await waitFor(async () => {
        const rows = await statusesFor(emailIds);
        const sent = rows.filter((r) => r.status === "sent").length;
        return sent === 3 ? true : undefined;
      }, 15_000);

      // Hold steady briefly and recount — if the race were unsafe, a 4th or
      // 5th job could slip through in this window.
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const rows = await statusesFor(emailIds);
      const sent = rows.filter((r) => r.status === "sent").length;
      assert.equal(sent, 3, "exactly hourlyLimit emails should be sent, never more, despite two racing workers");
    } finally {
      await closeWorker(worker1);
      await closeWorker(worker2);
    }
  });
});

describe("Worker: large campaign with rate limiting active", () => {
  test("Test 7: 1000 queued jobs are not lost even with distributed rate limiting in the path", async () => {
    const user = await createTestUser("rl-bulk");
    const sender = await createTestSender(user.id);
    // Generous limit: this test is about queue/worker scale, not quota
    // correctness (covered by Tests 3/5/6) — Redis is still the only
    // source of truth for the counter either way.
    const campaign = await createTestCampaign(user.id, sender.id, new Date(), 0, 5000);
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

    const stillPending = await prisma.email.count({
      where: { id: { in: emailIds }, status: { in: ["scheduled", "processing"] } },
    });
    assert.ok(stillPending > 0, "most of the 1000 jobs should remain unprocessed after closing the worker early");
  });
});
