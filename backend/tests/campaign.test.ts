import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { createApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { redisClient } from "../src/lib/redis.js";

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

async function createSender(userId: string, email: string) {
  return prisma.sender.create({ data: { userId, email } });
}

function validCampaignPayload(overrides: Record<string, unknown> = {}) {
  return {
    subject: "Meeting follow-up",
    body: "Hello...",
    recipients: ["john@gmail.com", "sarah@gmail.com", "alex@gmail.com"],
    startTime: "2026-08-14T10:00:00Z",
    delaySeconds: 2,
    hourlyLimit: 200,
    ...overrides,
  };
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
});

describe("POST /api/campaigns", () => {
  test("authenticated user can create a campaign", async () => {
    const user = await registerUser("create");
    const sender = await createSender(user.userId, "sales@company.com");

    const res = await fetch(`${baseUrl}/api/campaigns`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: user.cookie },
      body: JSON.stringify(validCampaignPayload({ senderId: sender.id })),
    });

    assert.equal(res.status, 201);
    const body = (await res.json()) as { campaignId: string; totalRecipients: number; status: string };
    assert.ok(body.campaignId);
    assert.equal(body.totalRecipients, 3);
    assert.equal(body.status, "scheduled");
  });

  test("campaign creates the correct number of Email records with spaced schedules", async () => {
    const user = await registerUser("email-count");
    const sender = await createSender(user.userId, "sales2@company.com");

    const res = await fetch(`${baseUrl}/api/campaigns`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: user.cookie },
      body: JSON.stringify(
        validCampaignPayload({
          senderId: sender.id,
          recipients: ["a@gmail.com", "b@gmail.com", "c@gmail.com", "d@gmail.com", "e@gmail.com"],
          delaySeconds: 2,
        }),
      ),
    });
    assert.equal(res.status, 201);
    const { campaignId } = (await res.json()) as { campaignId: string };

    const emails = await prisma.email.findMany({ where: { campaignId }, orderBy: { scheduledAt: "asc" } });
    assert.equal(emails.length, 5);
    assert.ok(emails.every((e) => e.status === "scheduled"));

    const start = new Date("2026-08-14T10:00:00Z").getTime();
    emails.forEach((email, index) => {
      assert.equal(email.scheduledAt.getTime(), start + index * 2000);
    });
  });

  test("duplicate recipients are de-duplicated rather than rejected", async () => {
    const user = await registerUser("dup-recipients");
    const sender = await createSender(user.userId, "sales3@company.com");

    const res = await fetch(`${baseUrl}/api/campaigns`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: user.cookie },
      body: JSON.stringify(
        validCampaignPayload({
          senderId: sender.id,
          recipients: ["dup@gmail.com", "DUP@gmail.com", " dup@gmail.com ", "unique@gmail.com"],
        }),
      ),
    });

    assert.equal(res.status, 201);
    const body = (await res.json()) as { campaignId: string; totalRecipients: number };
    assert.equal(body.totalRecipients, 2);

    const emails = await prisma.email.findMany({ where: { campaignId: body.campaignId } });
    assert.equal(emails.length, 2);
    assert.deepEqual(
      emails.map((e) => e.recipient).sort(),
      ["dup@gmail.com", "unique@gmail.com"],
    );
  });

  test("a sender belonging to another user is rejected", async () => {
    const owner = await registerUser("sender-owner");
    const intruder = await registerUser("sender-intruder");
    const sender = await createSender(owner.userId, "owned@company.com");

    const res = await fetch(`${baseUrl}/api/campaigns`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: intruder.cookie },
      body: JSON.stringify(validCampaignPayload({ senderId: sender.id })),
    });

    assert.equal(res.status, 404);

    const campaignCount = await prisma.campaign.count({ where: { senderId: sender.id } });
    assert.equal(campaignCount, 0);
  });

  test("unauthenticated request is rejected", async () => {
    const res = await fetch(`${baseUrl}/api/campaigns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validCampaignPayload({ senderId: randomUUID() })),
    });
    assert.equal(res.status, 401);
  });

  test("empty recipient list is rejected", async () => {
    const user = await registerUser("empty-recipients");
    const sender = await createSender(user.userId, "sales4@company.com");

    const res = await fetch(`${baseUrl}/api/campaigns`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: user.cookie },
      body: JSON.stringify(validCampaignPayload({ senderId: sender.id, recipients: [] })),
    });
    assert.equal(res.status, 400);
  });

  test("an invalid recipient address is rejected", async () => {
    const user = await registerUser("invalid-recipient");
    const sender = await createSender(user.userId, "sales5@company.com");

    const res = await fetch(`${baseUrl}/api/campaigns`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: user.cookie },
      body: JSON.stringify(
        validCampaignPayload({ senderId: sender.id, recipients: ["not-an-email", "ok@gmail.com"] }),
      ),
    });
    assert.equal(res.status, 400);
  });
});

describe("Campaign creation transaction", () => {
  test("a failed email insert rolls back the whole campaign transaction", async () => {
    const user = await registerUser("rollback");
    const sender = await createSender(user.userId, "rollback@company.com");
    const campaignId = randomUUID();

    await assert.rejects(
      prisma.$transaction(async (tx) => {
        await tx.campaign.create({
          data: {
            id: campaignId,
            userId: user.userId,
            senderId: sender.id,
            subject: "Rollback test",
            body: "Body",
            startTime: new Date(),
            delaySeconds: 1,
            hourlyLimit: 100,
          },
        });

        // Force a (campaignId, recipient) unique-constraint violation partway
        // through the email insert, simulating a mid-transaction failure.
        await tx.email.createMany({
          data: [
            { id: randomUUID(), campaignId, recipient: "dup@example.com", scheduledAt: new Date() },
            { id: randomUUID(), campaignId, recipient: "dup@example.com", scheduledAt: new Date() },
          ],
        });
      }),
    );

    const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
    assert.equal(campaign, null);

    const emailCount = await prisma.email.count({ where: { campaignId } });
    assert.equal(emailCount, 0);
  });
});

describe("GET /api/campaigns", () => {
  test("authenticated user sees only their own campaigns", async () => {
    const userA = await registerUser("list-a");
    const userB = await registerUser("list-b");
    const senderA = await createSender(userA.userId, "list-a@company.com");
    const senderB = await createSender(userB.userId, "list-b@company.com");

    const createRes = await fetch(`${baseUrl}/api/campaigns`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userA.cookie },
      body: JSON.stringify(validCampaignPayload({ senderId: senderA.id, subject: "A's campaign" })),
    });
    assert.equal(createRes.status, 201);

    await fetch(`${baseUrl}/api/campaigns`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: userB.cookie },
      body: JSON.stringify(validCampaignPayload({ senderId: senderB.id, subject: "B's campaign" })),
    });

    const res = await fetch(`${baseUrl}/api/campaigns`, { headers: { Cookie: userA.cookie } });
    assert.equal(res.status, 200);

    const body = (await res.json()) as {
      campaigns: Array<{ id: string; subject: string; senderId: string; totalRecipients: number; status: string }>;
    };
    assert.equal(body.campaigns.length, 1);
    assert.equal(body.campaigns[0]!.subject, "A's campaign");
    assert.equal(body.campaigns[0]!.senderId, senderA.id);
    assert.equal(body.campaigns[0]!.totalRecipients, 3);
    assert.equal(body.campaigns[0]!.status, "scheduled");
  });

  test("unauthenticated request is rejected", async () => {
    const res = await fetch(`${baseUrl}/api/campaigns`);
    assert.equal(res.status, 401);
  });
});
