import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { createApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { ioredisConnection, redisClient } from "../src/lib/redis.js";

let baseUrl: string;
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
const createdUserIds: string[] = [];

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

// These tests exercise pure read/list endpoints — campaigns and emails are
// seeded directly via Prisma (bypassing POST /api/campaigns and BullMQ
// entirely) so status combinations (scheduled/processing/sent/failed) can be
// set up directly without waiting on a worker.
async function createSender(userId: string, email: string) {
  return prisma.sender.create({ data: { userId, email, displayName: "Test Sender" } });
}

async function createCampaign(userId: string, senderId: string, subject: string) {
  return prisma.campaign.create({
    data: {
      userId,
      senderId,
      subject,
      body: "Body",
      startTime: new Date(),
      delaySeconds: 1,
      hourlyLimit: 100,
      status: "scheduled",
    },
  });
}

async function createEmail(
  campaignId: string,
  recipient: string,
  status: "scheduled" | "processing" | "sent" | "failed",
  extra: { sentAt?: Date; failedAt?: Date; failureReason?: string } = {},
) {
  return prisma.email.create({
    data: {
      campaignId,
      recipient,
      scheduledAt: new Date(),
      status,
      ...extra,
    },
  });
}

before(async () => {
  await redisClient.connect();
  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  await prisma.$disconnect();
  await redisClient.quit();
  if (ioredisConnection.status !== "end") {
    ioredisConnection.disconnect();
  }
});

describe("GET /api/emails/scheduled", () => {
  test("authenticated user sees only their own scheduled/processing emails", async () => {
    const userA = await registerUser("sched-a");
    const userB = await registerUser("sched-b");
    const senderA = await createSender(userA.userId, "a@company.com");
    const senderB = await createSender(userB.userId, "b@company.com");
    const campaignA = await createCampaign(userA.userId, senderA.id, "A's campaign");
    const campaignB = await createCampaign(userB.userId, senderB.id, "B's campaign");

    await createEmail(campaignA.id, "john@gmail.com", "scheduled");
    await createEmail(campaignA.id, "processing@gmail.com", "processing");
    await createEmail(campaignA.id, "sent@gmail.com", "sent", { sentAt: new Date() });
    await createEmail(campaignB.id, "sarah@gmail.com", "scheduled");

    const res = await fetch(`${baseUrl}/api/emails/scheduled`, { headers: { Cookie: userA.cookie } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      emails: Array<{ id: string; recipient: string; subject: string; scheduledAt: string; status: string }>;
      pagination: { page: number; limit: number; total: number; totalPages: number };
    };

    assert.equal(body.emails.length, 2);
    const recipients = body.emails.map((e) => e.recipient).sort();
    assert.deepEqual(recipients, ["john@gmail.com", "processing@gmail.com"]);
    assert.ok(body.emails.every((e) => e.subject === "A's campaign"));
    assert.ok(body.emails.every((e) => e.status === "scheduled" || e.status === "processing"));
    assert.equal(body.pagination.total, 2);
  });

  test("user isolation: user B never sees user A's scheduled emails, even via campaignId", async () => {
    const userA = await registerUser("sched-iso-a");
    const userB = await registerUser("sched-iso-b");
    const senderA = await createSender(userA.userId, "iso-a@company.com");
    const campaignA = await createCampaign(userA.userId, senderA.id, "A's private campaign");
    await createEmail(campaignA.id, "secret@gmail.com", "scheduled");

    const res = await fetch(`${baseUrl}/api/emails/scheduled?campaignId=${campaignA.id}`, {
      headers: { Cookie: userB.cookie },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { emails: unknown[] };
    assert.deepEqual(body.emails, []);
  });

  test("empty state returns an empty array, not an error", async () => {
    const user = await registerUser("sched-empty");
    const res = await fetch(`${baseUrl}/api/emails/scheduled`, { headers: { Cookie: user.cookie } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { emails: unknown[]; pagination: { total: number } };
    assert.deepEqual(body.emails, []);
    assert.equal(body.pagination.total, 0);
  });

  test("pagination: limit and page are respected", async () => {
    const user = await registerUser("sched-page");
    const sender = await createSender(user.userId, "page@company.com");
    const campaign = await createCampaign(user.userId, sender.id, "Bulk campaign");
    for (let i = 0; i < 5; i++) {
      await createEmail(campaign.id, `r${i}@gmail.com`, "scheduled");
    }

    const page1 = await fetch(`${baseUrl}/api/emails/scheduled?page=1&limit=2`, { headers: { Cookie: user.cookie } });
    const page1Body = (await page1.json()) as {
      emails: unknown[];
      pagination: { page: number; limit: number; total: number; totalPages: number };
    };
    assert.equal(page1Body.emails.length, 2);
    assert.equal(page1Body.pagination.total, 5);
    assert.equal(page1Body.pagination.totalPages, 3);

    const page3 = await fetch(`${baseUrl}/api/emails/scheduled?page=3&limit=2`, { headers: { Cookie: user.cookie } });
    const page3Body = (await page3.json()) as { emails: unknown[] };
    assert.equal(page3Body.emails.length, 1);

    const overLimit = await fetch(`${baseUrl}/api/emails/scheduled?limit=1000`, { headers: { Cookie: user.cookie } });
    assert.equal(overLimit.status, 400, "limit above the safe maximum should be rejected");
  });

  test("unauthenticated request is rejected", async () => {
    const res = await fetch(`${baseUrl}/api/emails/scheduled`);
    assert.equal(res.status, 401);
  });
});

describe("GET /api/emails/sent", () => {
  test("authenticated user sees only their own sent/failed emails", async () => {
    const userA = await registerUser("sent-a");
    const userB = await registerUser("sent-b");
    const senderA = await createSender(userA.userId, "sent-a@company.com");
    const senderB = await createSender(userB.userId, "sent-b@company.com");
    const campaignA = await createCampaign(userA.userId, senderA.id, "A's campaign");
    const campaignB = await createCampaign(userB.userId, senderB.id, "B's campaign");

    const sentAt = new Date();
    await createEmail(campaignA.id, "john@gmail.com", "sent", { sentAt });
    await createEmail(campaignA.id, "sarah@gmail.com", "failed", {
      failedAt: new Date(),
      failureReason: "Mailbox does not exist",
    });
    await createEmail(campaignA.id, "pending@gmail.com", "scheduled");
    await createEmail(campaignB.id, "other@gmail.com", "sent", { sentAt: new Date() });

    const res = await fetch(`${baseUrl}/api/emails/sent`, { headers: { Cookie: userA.cookie } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      emails: Array<{
        id: string;
        recipient: string;
        subject: string;
        sentAt: string | null;
        status: string;
        failureReason: string | null;
      }>;
    };

    assert.equal(body.emails.length, 2);
    const byRecipient = Object.fromEntries(body.emails.map((e) => [e.recipient, e]));
    assert.equal(byRecipient["john@gmail.com"]!.status, "sent");
    assert.ok(byRecipient["john@gmail.com"]!.sentAt);
    assert.equal(byRecipient["sarah@gmail.com"]!.status, "failed");
    assert.equal(byRecipient["sarah@gmail.com"]!.sentAt, null);
    assert.equal(byRecipient["sarah@gmail.com"]!.failureReason, "Mailbox does not exist");
  });

  test("status filter narrows to sent or failed only", async () => {
    const user = await registerUser("sent-filter");
    const sender = await createSender(user.userId, "filter@company.com");
    const campaign = await createCampaign(user.userId, sender.id, "Filter campaign");
    await createEmail(campaign.id, "ok@gmail.com", "sent", { sentAt: new Date() });
    await createEmail(campaign.id, "bad@gmail.com", "failed", { failedAt: new Date(), failureReason: "SMTP error" });

    const sentOnly = await fetch(`${baseUrl}/api/emails/sent?status=sent`, { headers: { Cookie: user.cookie } });
    const sentBody = (await sentOnly.json()) as { emails: Array<{ status: string }> };
    assert.equal(sentBody.emails.length, 1);
    assert.equal(sentBody.emails[0]!.status, "sent");

    const failedOnly = await fetch(`${baseUrl}/api/emails/sent?status=failed`, { headers: { Cookie: user.cookie } });
    const failedBody = (await failedOnly.json()) as { emails: Array<{ status: string }> };
    assert.equal(failedBody.emails.length, 1);
    assert.equal(failedBody.emails[0]!.status, "failed");
  });

  test("campaignId filter scopes to a single campaign within the user's own data", async () => {
    const user = await registerUser("sent-campaign-filter");
    const sender = await createSender(user.userId, "campaign-filter@company.com");
    const campaign1 = await createCampaign(user.userId, sender.id, "Campaign 1");
    const campaign2 = await createCampaign(user.userId, sender.id, "Campaign 2");
    await createEmail(campaign1.id, "one@gmail.com", "sent", { sentAt: new Date() });
    await createEmail(campaign2.id, "two@gmail.com", "sent", { sentAt: new Date() });

    const res = await fetch(`${baseUrl}/api/emails/sent?campaignId=${campaign1.id}`, {
      headers: { Cookie: user.cookie },
    });
    const body = (await res.json()) as { emails: Array<{ recipient: string }> };
    assert.equal(body.emails.length, 1);
    assert.equal(body.emails[0]!.recipient, "one@gmail.com");
  });

  test("empty state returns an empty array, not an error", async () => {
    const user = await registerUser("sent-empty");
    const res = await fetch(`${baseUrl}/api/emails/sent`, { headers: { Cookie: user.cookie } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { emails: unknown[] };
    assert.deepEqual(body.emails, []);
  });

  test("unauthenticated request is rejected", async () => {
    const res = await fetch(`${baseUrl}/api/emails/sent`);
    assert.equal(res.status, 401);
  });
});
