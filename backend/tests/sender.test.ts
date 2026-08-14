import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { createApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import { ioredisConnection, redisClient } from "../src/lib/redis.js";
import { closeEmailQueue } from "../src/queue/email.queue.js";

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
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  await closeEmailQueue();
  await prisma.$disconnect();
  await redisClient.quit();
  if (ioredisConnection.status !== "end") {
    ioredisConnection.disconnect();
  }
});

describe("GET /api/senders", () => {
  test("authenticated user with multiple senders receives only their own senders", async () => {
    const userA = await registerUser("user-a");
    const userB = await registerUser("user-b");

    await prisma.sender.createMany({
      data: [
        { userId: userA.userId, email: "oliver@company.com", displayName: "Oliver" },
        { userId: userA.userId, email: "sales@company.com", displayName: "Sales" },
        { userId: userB.userId, email: "other@company.com", displayName: "Other" },
      ],
    });

    const res = await fetch(`${baseUrl}/api/senders`, { headers: { Cookie: userA.cookie } });
    assert.equal(res.status, 200);

    const body = (await res.json()) as { senders: Array<{ id: string; email: string; displayName: string | null }> };
    assert.equal(body.senders.length, 2);
    assert.deepEqual(Object.keys(body.senders[0]!).sort(), ["displayName", "email", "id"]);

    const emails = body.senders.map((s) => s.email).sort();
    assert.deepEqual(emails, ["oliver@company.com", "sales@company.com"]);
    assert.ok(!body.senders.some((s) => s.email === "other@company.com"));
  });

  test("user with no senders receives an empty array", async () => {
    const user = await registerUser("no-senders");

    const res = await fetch(`${baseUrl}/api/senders`, { headers: { Cookie: user.cookie } });
    assert.equal(res.status, 200);

    const body = (await res.json()) as { senders: unknown[] };
    assert.deepEqual(body.senders, []);
  });

  test("unauthenticated request is rejected with 401", async () => {
    const res = await fetch(`${baseUrl}/api/senders`);
    assert.equal(res.status, 401);
  });

  test("a sender belonging to another user is never returned, even with a shared session", async () => {
    const owner = await registerUser("owner");
    const intruder = await registerUser("intruder");

    const secretSender = await prisma.sender.create({
      data: { userId: owner.userId, email: "secret@company.com", displayName: "Secret" },
    });

    const res = await fetch(`${baseUrl}/api/senders`, { headers: { Cookie: intruder.cookie } });
    const body = (await res.json()) as { senders: Array<{ id: string }> };

    assert.ok(!body.senders.some((s) => s.id === secretSender.id));
  });
});

describe("Sender (userId, email) uniqueness", () => {
  test("creating a duplicate (userId, email) pair is rejected by the database constraint", async () => {
    const user = await registerUser("dup");
    await prisma.sender.create({ data: { userId: user.userId, email: "dup@company.com" } });

    await assert.rejects(
      prisma.sender.create({ data: { userId: user.userId, email: "dup@company.com" } }),
      (err: unknown) => (err as { code?: string }).code === "P2002",
    );
  });
});
