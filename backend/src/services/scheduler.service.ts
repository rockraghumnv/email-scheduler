import { enqueueEmailJobs } from "../queue/email.queue.js";
import type { EmailJobRequest } from "../queue/queue.types.js";

export interface SchedulableEmail {
  id: string;
  scheduledAt: Date;
}

/**
 * Delay policy for provisioning BullMQ jobs from a persisted `scheduledAt`:
 *  - future scheduledAt  -> positive delay, BullMQ marks the job "delayed"
 *  - scheduledAt ~= now  -> ~0 delay, job is immediately eligible ("waiting")
 *  - past scheduledAt    -> clamped to 0 (never negative), immediately eligible
 * The stored `scheduledAt` in Postgres is never rewritten by this — only how
 * soon the queue makes the job available is affected.
 */
export function calculateDelayMs(scheduledAt: Date, now: Date = new Date()): number {
  return Math.max(0, scheduledAt.getTime() - now.getTime());
}

/**
 * Turns already-persisted Email records into BullMQ delayed jobs. Callable
 * with either the rows just created in the same request (the normal path,
 * see campaign.service.ts) or with rows re-read from Postgres by campaignId
 * later — this is what makes provisioning retryable after a partial failure:
 * deterministic job ids mean re-running this for the same emails is safe.
 */
export async function scheduleCampaignEmails(campaignId: string, emails: SchedulableEmail[]): Promise<void> {
  if (emails.length === 0) {
    return;
  }

  const requests: EmailJobRequest[] = emails.map((email) => ({
    emailId: email.id,
    campaignId,
    delayMs: calculateDelayMs(email.scheduledAt),
  }));

  await enqueueEmailJobs(requests);
}
