import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, describe, mock, test } from "node:test";
import { prisma } from "../src/lib/prisma.js";
import { ioredisConnection } from "../src/lib/redis.js";

// Controls how the mocked smtp.service.js behaves per-recipient, so several
// independent test scenarios (transient/permanent/eventual-success/already
// sent) can share one mock.module call without interfering with each other.
// Kept in its own file/process (node:test runs each file separately) so
// this mock can never leak into the other reliability tests that need the
// real Ethereal transport.
interface FailurePlan {
  remainingFailures: number;
  permanent: boolean;
}
const plans = new Map<string, FailurePlan>();
let sendMailCallCount = 0;
const callsByRecipient = new Map<string, number>();

mock.module("../src/services/smtp.service.js", {
  exports: {
    sendMail: async (options: { to: string }) => {
      sendMailCallCount++;
      callsByRecipient.set(options.to, (callsByRecipient.get(options.to) ?? 0) + 1);

      const plan = plans.get(options.to);
      if (plan && (plan.permanent || plan.remainingFailures > 0)) {
        if (!plan.permanent) {
          plan.remainingFailures--;
        }
        const err = new Error("Simulated SMTP failure") as Error & { responseCode?: number };
        if (plan.permanent) {
          err.responseCode = 550; // RFC 5321 permanent failure
        }
        throw err;
      }
      return { messageId: `mock-${randomUUID()}`, response: "250 OK" };
    },
    getPreviewUrl: () => false as const,
    verifySmtpConnection: async () => true,
  },
});

const { createEmailWorker } = await import("../src/queue/email.worker.js");
const { closeEmailQueue, getEmailJobState, removeEmailJobs } = await import("../src/queue/email.queue.js");
const { scheduleCampaignEmails } = await import("../src/services/scheduler.service.js");
const { processEmailSend } = await import("../src/services/email.service.js");

const createdUserIds: string[] = [];
const provisionedEmailIds: string[] = [];
const activeWorkers: import("bullmq").Worker[] = [];

async function createTestUser(prefix: string) {
  const user = await prisma.user.create({ data: { email: `${prefix}-${randomUUID()}@example.test`, name: "Test User" } });
  createdUserIds.push(user.id);
  return user;
}

async function createTestSender(userId: string) {
  return prisma.sender.create({ data: { userId, email: `sender-${randomUUID()}@company.test`, displayName: "Test Sender" } });
}

async function createTestCampaign(userId: string, senderId: string) {
  return prisma.campaign.create({
    data: {
      userId,
      senderId,
      subject: "Reliability test",
      body: "Hello from the reliability test suite.",
      startTime: new Date(),
      delaySeconds: 0,
      hourlyLimit: 1000,
    },
  });
}

async function createDueEmail(campaignId: string, recipient: string) {
  const email = await prisma.email.create({ data: { campaignId, recipient, scheduledAt: new Date() } });
  provisionedEmailIds.push(email.id);
  return email;
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

function trackWorker(worker: import("bullmq").Worker) {
  activeWorkers.push(worker);
  return worker;
}
async function closeWorker(worker: import("bullmq").Worker) {
  await worker.close();
  const i = activeWorkers.indexOf(worker);
  if (i !== -1) activeWorkers.splice(i, 1);
}

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

describe("Retry classification", () => {
  test("Test 2 + Test 3: a transient SMTP failure is retried and the retry succeeds", async () => {
    const user = await createTestUser("rel-transient");
    const sender = await createTestSender(user.id);
    const campaign = await createTestCampaign(user.id, sender.id);
    const recipient = `transient-${randomUUID()}@ethereal.email`;
    const email = await createDueEmail(campaign.id, recipient);

    // Fail exactly once (transient, no responseCode), then succeed.
    plans.set(recipient, { remainingFailures: 1, permanent: false });

    await scheduleCampaignEmails(campaign.id, [{ id: email.id, scheduledAt: new Date() }]);

    const worker = trackWorker(createEmailWorker({ concurrency: 1 }));
    try {
      // Intermediate state: after the first (failing) attempt, the email
      // must be back to "scheduled" (retryable), not "failed" — proving the
      // failure was classified as transient rather than final.
      await waitFor(async () => ((callsByRecipient.get(recipient) ?? 0) >= 1 ? true : undefined), 10_000);
      await waitFor(async () => {
        const e = await prisma.email.findUniqueOrThrow({ where: { id: email.id } });
        return e.status === "scheduled" || e.status === "sent" ? true : undefined;
      }, 10_000);

      // Final state: the automatic retry (exponential backoff) eventually
      // succeeds.
      const finalEmail = await waitFor(async () => {
        const e = await prisma.email.findUniqueOrThrow({ where: { id: email.id } });
        return e.status === "sent" ? e : undefined;
      }, 15_000);

      assert.equal(finalEmail.status, "sent");
      assert.equal(finalEmail.failedAt, null);
      assert.ok((callsByRecipient.get(recipient) ?? 0) >= 2, "sendMail should have been called at least twice (fail, then succeed)");
    } finally {
      await closeWorker(worker);
    }
  });

  test("Test 4: a permanent SMTP failure (5xx) fails immediately without retrying", async () => {
    const user = await createTestUser("rel-permanent");
    const sender = await createTestSender(user.id);
    const campaign = await createTestCampaign(user.id, sender.id);
    const recipient = `permanent-${randomUUID()}@ethereal.email`;
    const email = await createDueEmail(campaign.id, recipient);

    plans.set(recipient, { remainingFailures: 0, permanent: true });

    await scheduleCampaignEmails(campaign.id, [{ id: email.id, scheduledAt: new Date() }]);

    const worker = trackWorker(createEmailWorker({ concurrency: 1 }));
    try {
      const finalEmail = await waitFor(async () => {
        const e = await prisma.email.findUniqueOrThrow({ where: { id: email.id } });
        return e.status === "failed" ? e : undefined;
      }, 10_000);

      assert.equal(finalEmail.status, "failed");
      assert.ok(finalEmail.failedAt);
      assert.equal(finalEmail.failureReason, "Simulated SMTP failure");

      // Give the queue a moment to settle, then confirm no retry happened —
      // configured attempts default to 3, so more than 1 call would mean a
      // permanent failure was incorrectly retried.
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.equal(callsByRecipient.get(recipient), 1, "a permanent failure must not be retried");
      assert.equal(await getEmailJobState(email.id), "failed");
    } finally {
      await closeWorker(worker);
    }
  });
});

describe("Idempotent worker behavior", () => {
  test("Test 5: an already-sent email is never sent twice", async () => {
    const user = await createTestUser("rel-already-sent");
    const sender = await createTestSender(user.id);
    const campaign = await createTestCampaign(user.id, sender.id);
    const recipient = `already-sent-${randomUUID()}@ethereal.email`;
    const email = await createDueEmail(campaign.id, recipient);

    // Simulate "already sent by a previous execution" directly.
    await prisma.email.update({
      where: { id: email.id },
      data: { status: "sent", sentAt: new Date() },
    });

    const before = sendMailCallCount;
    const result = await processEmailSend(email.id);
    assert.equal(result.outcome, "skipped");
    assert.equal(sendMailCallCount, before, "sendMail must not be called for an already-sent email");

    const unchanged = await prisma.email.findUniqueOrThrow({ where: { id: email.id } });
    assert.equal(unchanged.status, "sent");
  });
});
