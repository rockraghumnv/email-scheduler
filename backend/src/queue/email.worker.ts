import { fileURLToPath } from "node:url";
import { DelayedError, UnrecoverableError, Worker, type Job } from "bullmq";
import { env, isProduction } from "../config/env.js";
import { ioredisConnection } from "../lib/redis.js";
import { markEmailFailed, processEmailSend } from "../services/email.service.js";
import { verifySmtpConnection } from "../services/smtp.service.js";
import { isPermanentFailure } from "../utils/idempotency.js";
import { EMAIL_QUEUE_NAME } from "./email.queue.js";
import type { EmailJobData } from "./queue.types.js";

export interface CreateEmailWorkerOptions {
  concurrency?: number;
  /** Test-only: override BullMQ's default 30s lock/stalled-check timing to
   * exercise crash recovery without a real 30s+ wait. */
  lockDuration?: number;
  stalledInterval?: number;
  /** Test-only: pairs with lockDuration — see processEmailSend's
   * staleThresholdMs param. Keeping this decoupled from lockDuration by
   * default (rather than deriving one from the other) means a worker only
   * needs to opt in to the short DB-reclaim window when it's *also* using a
   * shortened BullMQ lock, which is exactly the crash-recovery test case. */
  staleProcessingThresholdMs?: number;
}

/**
 * Builds (but does not start listening for signals on) an email worker.
 * Exported so tests can create/close their own worker instances against the
 * same queue instead of shelling out to `npm run worker`.
 */
export function createEmailWorker(options: CreateEmailWorkerOptions = {}): Worker<EmailJobData> {
  const worker = new Worker<EmailJobData>(
    EMAIL_QUEUE_NAME,
    async (job: Job<EmailJobData>, token?: string) => {
      const { emailId } = job.data;
      const attempt = job.attemptsMade + 1;
      const maxAttempts = job.opts.attempts ?? 1;
      console.log(`[Worker] Job ${job.id} received (email ${emailId}, attempt ${attempt}/${maxAttempts})`);

      let result;
      try {
        result =
          options.staleProcessingThresholdMs !== undefined
            ? await processEmailSend(emailId, options.staleProcessingThresholdMs)
            : await processEmailSend(emailId);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        const permanent = isPermanentFailure(err);
        // Mirrors BullMQ's own retry decision (Job.shouldRetryJob) so the DB
        // record and the queue's actual behavior never disagree: if BullMQ
        // is about to retry, leave the email "scheduled" (already done by
        // processEmailSend's revert) for that retry to claim; only mark it
        // permanently failed once we know no further attempt is coming.
        const willRetry = !permanent && attempt < maxAttempts;

        if (willRetry) {
          console.error(
            `[Worker] Email ${emailId} transient failure (job ${job.id}, attempt ${attempt}/${maxAttempts}): ${message} — will retry`,
          );
          throw err;
        }

        console.error(
          `[Worker] Email ${emailId} permanently failed (job ${job.id}, attempt ${attempt}/${maxAttempts}, permanent=${permanent}): ${message}`,
        );
        await markEmailFailed(emailId, message);
        throw new UnrecoverableError(message);
      }

      if (result.outcome === "rate_limited") {
        console.log(
          `[Worker] Email ${emailId} rate-limited (${result.reason}) — rescheduling for ${result.nextAllowedAt.toISOString()}`,
        );
        // Re-delay this same job (same jobId, no duplicate) rather than
        // failing or completing it. DelayedError tells BullMQ's worker loop
        // this wasn't a real failure — see job.moveToDelayed docs.
        await job.moveToDelayed(result.nextAllowedAt.getTime(), token);
        throw new DelayedError();
      }

      if (result.outcome === "sent") {
        if (!isProduction && result.previewUrl) {
          console.log(`[Worker] Email ${emailId} preview: ${result.previewUrl}`);
        }
        console.log(`[Worker] Email ${emailId} sent successfully`);
      } else {
        console.log(`[Worker] Email ${emailId} skipped (not in a sendable state — already handled)`);
      }

      console.log(`[Worker] Job ${job.id} completed`);
    },
    {
      connection: ioredisConnection,
      concurrency: options.concurrency ?? env.WORKER_CONCURRENCY,
      ...(options.lockDuration !== undefined ? { lockDuration: options.lockDuration } : {}),
      ...(options.stalledInterval !== undefined ? { stalledInterval: options.stalledInterval } : {}),
    },
  );

  worker.on("active", (job) => {
    console.log(`[Worker] Email ${job.data.emailId} processing (job ${job.id})`);
  });

  worker.on("failed", (job, err) => {
    // Fires on every failed attempt, not just the final one — the
    // processor's own logging above already distinguishes "will retry" vs
    // "permanent", so this is just a backstop for attempts/errors that
    // don't go through that path (e.g. a lock lost mid-send).
    const attempt = job?.attemptsMade ?? "?";
    const maxAttempts = job?.opts.attempts ?? "?";
    console.error(
      `[Worker] Job ${job?.id ?? "unknown"} (email ${job?.data.emailId ?? "unknown"}) attempt ${attempt}/${maxAttempts} failed: ${err.message}`,
    );
  });

  worker.on("error", (err) => {
    console.error("[Worker] Connection/worker error:", err.message);
  });

  return worker;
}

async function main() {
  console.log(`[Worker] Starting (queue=${EMAIL_QUEUE_NAME}, concurrency=${env.WORKER_CONCURRENCY})`);
  await verifySmtpConnection();

  const worker = createEmailWorker();
  console.log("[Worker] Started, waiting for jobs...");

  let shuttingDown = false;
  async function shutdown(signal: string) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`[Worker] ${signal} received — closing gracefully (waiting for active jobs to finish)...`);
    await worker.close();
    ioredisConnection.disconnect();
    console.log("[Worker] Closed.");
    process.exit(0);
  }

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

// Only auto-start when run directly (`npm run worker`), not when imported
// by tests or other modules.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("[Worker] Fatal startup error:", err);
    process.exit(1);
  });
}
