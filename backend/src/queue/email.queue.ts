import { Queue } from "bullmq";
import { env } from "../config/env.js";
import { ioredisConnection } from "../lib/redis.js";
import { EMAIL_JOB_NAME, type EmailJobData, type EmailJobRequest } from "./queue.types.js";

export const EMAIL_QUEUE_NAME = "email-sending";

// Single shared Queue instance for the whole process — BullMQ Queue objects
// manage their own connection state and are meant to be reused, not
// constructed per request.
const emailQueue = new Queue<EmailJobData>(EMAIL_QUEUE_NAME, {
  connection: ioredisConnection,
});

export function buildEmailJobId(emailId: string): string {
  return `email-${emailId}`;
}

/**
 * Adds one BullMQ job per request in a single bulk call. Each job's id is
 * deterministic (`buildEmailJobId`), so calling this again for an email that
 * was already provisioned is a safe no-op for that job — BullMQ does not add
 * a second job for a jobId that already exists. This prevents duplicate
 * *queue* entries; it does not by itself guarantee exactly-once SMTP
 * delivery, which is a worker-stage concern.
 */
export async function enqueueEmailJobs(requests: EmailJobRequest[]): Promise<void> {
  if (requests.length === 0) {
    return;
  }

  await emailQueue.addBulk(
    requests.map((request) => ({
      name: EMAIL_JOB_NAME,
      data: { emailId: request.emailId, campaignId: request.campaignId },
      opts: {
        jobId: buildEmailJobId(request.emailId),
        delay: request.delayMs,
        // Transient-failure retry policy (see src/utils/idempotency.ts for
        // which failures actually consume an attempt vs fail immediately).
        attempts: env.EMAIL_JOB_ATTEMPTS,
        backoff: { type: "exponential", delay: env.EMAIL_RETRY_BACKOFF_MS },
      },
    })),
  );
}

export async function getEmailQueueCounts(): Promise<Record<string, number>> {
  return emailQueue.getJobCounts("waiting", "delayed", "active", "completed", "failed");
}

export async function getEmailJobState(emailId: string): Promise<string | undefined> {
  const job = await emailQueue.getJob(buildEmailJobId(emailId));
  return job ? await job.getState() : undefined;
}

// Test/cleanup helper — not part of the request-handling path.
export async function removeEmailJobs(emailIds: string[]): Promise<void> {
  await Promise.all(emailIds.map((emailId) => emailQueue.remove(buildEmailJobId(emailId))));
}

export async function closeEmailQueue(): Promise<void> {
  await emailQueue.close();
}
