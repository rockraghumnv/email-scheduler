import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { createApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { ioredisConnection, redisClient } from "../src/lib/redis.js";
import { closeEmailQueue, getEmailJobState, getEmailQueueCounts, removeEmailJobs } from "../src/queue/email.queue.js";
import { calculateDelayMs, scheduleCampaignEmails } from "../src/services/scheduler.service.js";
import { createCampaign } from "../src/services/campaign.service.js";

let baseUrl: string;
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
const createdUserIds: string[] = [];
const provisionedEmailIds: string[] = [];

interface AuthedUser {
  userId: string;
  cookie: string;
}

async function registerUser(prefix: string): Promise<AuthedUser> {
  const email = `${prefix}-${randomUUID()}@example.test`;
  const res = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "password123", name: "Test User" }),
  });
  assert.equal(res.status, 201);

  const setCookie = res.headers.get("set-cookie");
  assert.ok(setCookie, "expected a session cookie on register");
  const cookie = setCookie.split(";")[0]!;

  const body = (await res.json()) as { user: { id: string } };
  createdUserIds.push(body.user.id);

  return { userId: body.user.id, cookie };
}

async function createSender(userId: string, email: string) {
  return prisma.sender.create({ data: { userId, email } });
}

before(async () => {
  await redisClient.connect();
  // ioredisConnection is not connected here — BullMQ's Queue (constructed
  // when app.js imports the queue module) manages that connection itself.
  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await removeEmailJobs(provisionedEmailIds);
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  await closeEmailQueue();
  await prisma.$disconnect();
  await redisClient.quit();
  if (ioredisConnection.status !== "end") {
    ioredisConnection.disconnect();
  }
});

describe("calculateDelayMs (pure delay policy)", () => {
  test("future scheduledAt yields a positive delay", () => {
    const now = new Date("2026-08-14T09:00:00Z");
    const scheduledAt = new Date("2026-08-14T10:00:00Z");
    assert.equal(calculateDelayMs(scheduledAt, now), 60 * 60 * 1000);
  });

  test("scheduledAt equal to now yields zero delay", () => {
    const now = new Date("2026-08-14T09:00:00Z");
    assert.equal(calculateDelayMs(now, now), 0);
  });

  test("past scheduledAt is clamped to zero, never negative", () => {
    const now = new Date("2026-08-14T09:00:00Z");
    const scheduledAt = new Date("2026-08-14T08:00:00Z");
    assert.equal(calculateDelayMs(scheduledAt, now), 0);
  });
});

describe("campaign creation -> BullMQ provisioning", () => {
  test("Test 1: one scheduled email produces one BullMQ job", async () => {
    const user = await registerUser("queue-one");
    const sender = await createSender(user.userId, "one@company.com");

    const result = await createCampaign({
      userId: user.userId,
      senderId: sender.id,
      subject: "One email",
      body: "Body",
      recipients: ["single@gmail.com"],
      startTime: new Date(Date.now() + 60 * 60 * 1000),
      delaySeconds: 2,
      hourlyLimit: 200,
    });

    const emails = await prisma.email.findMany({ where: { campaignId: result.campaignId } });
    assert.equal(emails.length, 1);
    provisionedEmailIds.push(...emails.map((e) => e.id));

    const state = await getEmailJobState(emails[0]!.id);
    assert.equal(state, "delayed");
  });

  test("Test 2: five recipients produce five BullMQ jobs", async () => {
    const user = await registerUser("queue-five");
    const sender = await createSender(user.userId, "five@company.com");

    const result = await createCampaign({
      userId: user.userId,
      senderId: sender.id,
      subject: "Five emails",
      body: "Body",
      recipients: ["a@gmail.com", "b@gmail.com", "c@gmail.com", "d@gmail.com", "e@gmail.com"],
      startTime: new Date(Date.now() + 60 * 60 * 1000),
      delaySeconds: 2,
      hourlyLimit: 200,
    });

    const emails = await prisma.email.findMany({ where: { campaignId: result.campaignId } });
    assert.equal(emails.length, 5);
    provisionedEmailIds.push(...emails.map((e) => e.id));

    const states = await Promise.all(emails.map((e) => getEmailJobState(e.id)));
    assert.deepEqual(
      states.every((s) => s === "delayed"),
      true,
    );
  });

  test("Test 3: re-provisioning the same email is a safe no-op, not a duplicate job", async () => {
    const user = await registerUser("queue-dedupe");
    const sender = await createSender(user.userId, "dedupe@company.com");
    const scheduledAt = new Date(Date.now() + 60 * 60 * 1000);

    const campaign = await prisma.campaign.create({
      data: {
        userId: user.userId,
        senderId: sender.id,
        subject: "Dedupe test",
        body: "Body",
        startTime: scheduledAt,
        delaySeconds: 1,
        hourlyLimit: 100,
      },
    });
    const email = await prisma.email.create({
      data: { campaignId: campaign.id, recipient: "dedupe@gmail.com", scheduledAt },
    });
    provisionedEmailIds.push(email.id);

    await scheduleCampaignEmails(campaign.id, [{ id: email.id, scheduledAt }]);
    const countsAfterFirst = await getEmailQueueCounts();

    // Re-run provisioning for the exact same logical email.
    await scheduleCampaignEmails(campaign.id, [{ id: email.id, scheduledAt }]);
    const countsAfterSecond = await getEmailQueueCounts();

    assert.deepEqual(countsAfterSecond, countsAfterFirst);
    assert.equal(await getEmailJobState(email.id), "delayed");
  });

  test("Test 4: future scheduledAt appears as a delayed job", async () => {
    const user = await registerUser("queue-future");
    const sender = await createSender(user.userId, "future@company.com");

    const result = await createCampaign({
      userId: user.userId,
      senderId: sender.id,
      subject: "Future",
      body: "Body",
      recipients: ["future@gmail.com"],
      startTime: new Date(Date.now() + 60 * 60 * 1000),
      delaySeconds: 1,
      hourlyLimit: 100,
    });

    const email = await prisma.email.findFirstOrThrow({ where: { campaignId: result.campaignId } });
    provisionedEmailIds.push(email.id);

    assert.equal(await getEmailJobState(email.id), "delayed");
  });

  test("Test 5: scheduledAt ~= now is immediately eligible, not delayed", async () => {
    const user = await registerUser("queue-immediate");
    const sender = await createSender(user.userId, "immediate@company.com");

    const result = await createCampaign({
      userId: user.userId,
      senderId: sender.id,
      subject: "Immediate",
      body: "Body",
      recipients: ["immediate@gmail.com"],
      startTime: new Date(),
      delaySeconds: 1,
      hourlyLimit: 100,
    });

    const email = await prisma.email.findFirstOrThrow({ where: { campaignId: result.campaignId } });
    provisionedEmailIds.push(email.id);

    assert.equal(await getEmailJobState(email.id), "waiting");
  });

  test("Test 6: past scheduledAt is immediately eligible and the stored timestamp is untouched", async () => {
    const user = await registerUser("queue-past");
    const sender = await createSender(user.userId, "past@company.com");
    const pastStartTime = new Date(Date.now() - 60 * 60 * 1000);

    const result = await createCampaign({
      userId: user.userId,
      senderId: sender.id,
      subject: "Past",
      body: "Body",
      recipients: ["past@gmail.com"],
      startTime: pastStartTime,
      delaySeconds: 1,
      hourlyLimit: 100,
    });

    const email = await prisma.email.findFirstOrThrow({ where: { campaignId: result.campaignId } });
    provisionedEmailIds.push(email.id);

    assert.equal(await getEmailJobState(email.id), "waiting");
    // Policy: a past-due scheduledAt only changes the queue delay, never the
    // persisted value.
    assert.equal(email.scheduledAt.getTime(), pastStartTime.getTime());
  });

  test("Test 7: a 1000-recipient campaign provisions 1000 jobs via bulk insertion", async () => {
    const user = await registerUser("queue-bulk");
    const sender = await createSender(user.userId, "bulk@company.com");
    const recipients = Array.from({ length: 1000 }, (_, i) => `bulk-${i}@loadtest.example`);

    const result = await createCampaign({
      userId: user.userId,
      senderId: sender.id,
      subject: "Bulk campaign",
      body: "Body",
      recipients,
      startTime: new Date(Date.now() + 60 * 60 * 1000),
      delaySeconds: 1,
      hourlyLimit: 5000,
    });

    assert.equal(result.totalRecipients, 1000);

    const emails = await prisma.email.findMany({
      where: { campaignId: result.campaignId },
      select: { id: true },
    });
    assert.equal(emails.length, 1000);
    provisionedEmailIds.push(...emails.map((e) => e.id));

    const sample = emails.slice(0, 5);
    const states = await Promise.all(sample.map((e) => getEmailJobState(e.id)));
    assert.ok(states.every((s) => s === "delayed"));
  });
});

describe("DB <-> queue consistency", () => {
  test("Test 8: Redis unavailable during provisioning fails loudly, keeps the DB row, and is safely retryable", async () => {
    const user = await registerUser("queue-redis-down");
    const sender = await createSender(user.userId, "redisdown@company.com");

    ioredisConnection.disconnect();

    try {
      await assert.rejects(
        createCampaign({
          userId: user.userId,
          senderId: sender.id,
          subject: "Redis down",
          body: "Body",
          recipients: ["redisdown@gmail.com"],
          startTime: new Date(Date.now() + 60 * 60 * 1000),
          delaySeconds: 1,
          hourlyLimit: 100,
        }),
        (err: unknown) => (err as { statusCode?: number }).statusCode === 502,
      );

      // The campaign and its email must still exist — provisioning failing
      // must not roll back or lose the already-committed DB records. (Redis
      // is still down here, so we deliberately don't query BullMQ state yet
      // — that call would itself throw "Connection is closed".)
      const campaign = await prisma.campaign.findFirst({ where: { subject: "Redis down", userId: user.userId } });
      assert.ok(campaign, "campaign should still exist after a provisioning failure");
      const email = await prisma.email.findFirstOrThrow({ where: { campaignId: campaign!.id } });
      provisionedEmailIds.push(email.id);

      await ioredisConnection.connect();

      // Retrying provisioning for the same (already-persisted) email must
      // succeed now that Redis is back, using the same deterministic job id.
      await scheduleCampaignEmails(campaign!.id, [{ id: email.id, scheduledAt: email.scheduledAt }]);
      assert.equal(await getEmailJobState(email.id), "delayed");
    } finally {
      // Guarantee Redis is reconnected before later tests/hooks run, even if
      // an assertion above failed partway through.
      if (ioredisConnection.status !== "ready" && ioredisConnection.status !== "connecting") {
        await ioredisConnection.connect();
      }
    }
  });
});

describe("Postgres failure -> no orphaned jobs", () => {
  test("Test 9: a rolled-back transaction never results in a BullMQ job", async () => {
    const user = await registerUser("queue-pg-fail");
    const sender = await createSender(user.userId, "pgfail@company.com");
    const campaignId = randomUUID();
    const emailId = randomUUID();

    await assert.rejects(
      prisma.$transaction(async (tx) => {
        await tx.campaign.create({
          data: {
            id: campaignId,
            userId: user.userId,
            senderId: sender.id,
            subject: "PG failure",
            body: "Body",
            startTime: new Date(),
            delaySeconds: 1,
            hourlyLimit: 100,
          },
        });

        // Forces a unique-constraint violation, exactly like the Stage 3
        // rollback test — this must never reach the scheduling step.
        await tx.email.createMany({
          data: [
            { id: emailId, campaignId, recipient: "dup@example.com", scheduledAt: new Date() },
            { id: randomUUID(), campaignId, recipient: "dup@example.com", scheduledAt: new Date() },
          ],
        });
      }),
    );

    const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
    assert.equal(campaign, null);
    assert.equal(await getEmailJobState(emailId), undefined, "no job should exist for an email that never committed");
  });
});
