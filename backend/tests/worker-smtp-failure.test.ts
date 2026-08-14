import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, mock, test } from "node:test";
import { prisma } from "../src/lib/prisma.js";
import { ioredisConnection } from "../src/lib/redis.js";

// This test forces smtp.service.js's sendMail() to throw, so it needs to be
// mocked before anything (including this file's own later imports) resolves
// the real module. Kept in its own file/process — node:test runs each test
// file separately — so the mock can never leak into the other worker tests.
mock.module("../src/services/smtp.service.js", {
  exports: {
    sendMail: async () => {
      throw new Error("Simulated SMTP failure");
    },
    getPreviewUrl: () => false,
    verifySmtpConnection: async () => false,
  },
});

const { processEmailSend } = await import("../src/services/email.service.js");

const createdUserIds: string[] = [];

before(async () => {
  // processEmailSend calls rate-limit.service.ts's reserveSendSlot directly,
  // without ever going through a Worker/Queue — so nothing else in this file
  // triggers ioredisConnection's lazyConnect handshake. Do it explicitly
  // (enableOfflineQueue is false, so an unconnected client throws instead of
  // queuing the command).
  if (ioredisConnection.status === "wait") {
    await ioredisConnection.connect();
  } else {
    while (ioredisConnection.status !== "ready") {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
});

after(async () => {
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
  if (ioredisConnection.status !== "end") {
    ioredisConnection.disconnect();
  }
});

test("Test 5: an SMTP failure reverts the email to scheduled and rejects (the worker layer, not processEmailSend, decides retry vs permanent)", async () => {
  const user = await prisma.user.create({
    data: { email: `worker-smtp-fail-${randomUUID()}@example.test`, name: "Test User" },
  });
  createdUserIds.push(user.id);
  const sender = await prisma.sender.create({
    data: { userId: user.id, email: `sender-${randomUUID()}@company.test`, displayName: "Test Sender" },
  });
  const campaign = await prisma.campaign.create({
    data: {
      userId: user.id,
      senderId: sender.id,
      subject: "SMTP failure test",
      body: "This send is expected to fail.",
      startTime: new Date(),
      delaySeconds: 1,
      hourlyLimit: 100,
    },
  });
  const email = await prisma.email.create({
    data: { campaignId: campaign.id, recipient: "recipient@ethereal.email", scheduledAt: new Date() },
  });

  await assert.rejects(processEmailSend(email.id), /Simulated SMTP failure/);

  // processEmailSend itself never makes the retry-vs-permanent call — it
  // always reverts to "scheduled" and rethrows, leaving that decision to
  // email.worker.ts (attempts remaining + isPermanentFailure). Calling it
  // directly here (bypassing the worker) should leave the email retryable.
  const reverted = await prisma.email.findUniqueOrThrow({ where: { id: email.id } });
  assert.equal(reverted.status, "scheduled");
  assert.equal(reverted.failedAt, null);
  assert.equal(reverted.sentAt, null);
});
