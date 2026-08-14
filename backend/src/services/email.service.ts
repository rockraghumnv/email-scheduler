import { EmailStatus } from "../../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { NotFoundError } from "../utils/errors.js";
import { PROCESSING_STALE_THRESHOLD_MS } from "../utils/idempotency.js";
import { reserveSendSlot } from "./rate-limit.service.js";
import { getPreviewUrl, sendMail } from "./smtp.service.js";

interface EmailForSending {
  id: string;
  recipient: string;
  subject: string;
  body: string;
  senderId: string;
  senderEmail: string;
  senderDisplayName: string | null;
  delaySeconds: number;
  hourlyLimit: number;
}

// The single place the worker's "look up what to send" query lives. Email ->
// Campaign -> Sender are all required (non-nullable) relations enforced by
// foreign keys in the schema, so if the Email row exists its campaign and
// sender are guaranteed to exist too — there's no "orphaned email" case to
// defend against here. delaySeconds/hourlyLimit come from the email's own
// campaign — see rate-limit.service.ts for why.
async function loadEmailForSending(emailId: string): Promise<EmailForSending | null> {
  const email = await prisma.email.findUnique({
    where: { id: emailId },
    select: {
      id: true,
      recipient: true,
      campaign: {
        select: {
          subject: true,
          body: true,
          delaySeconds: true,
          hourlyLimit: true,
          sender: { select: { id: true, email: true, displayName: true } },
        },
      },
    },
  });

  if (!email) {
    return null;
  }

  return {
    id: email.id,
    recipient: email.recipient,
    subject: email.campaign.subject,
    body: email.campaign.body,
    senderId: email.campaign.sender.id,
    senderEmail: email.campaign.sender.email,
    senderDisplayName: email.campaign.sender.displayName,
    delaySeconds: email.campaign.delaySeconds,
    hourlyLimit: email.campaign.hourlyLimit,
  };
}

/**
 * Atomically claims an email for sending. Matches two cases in one
 * conditional UPDATE:
 *  - status = "scheduled"                      (the ordinary case)
 *  - status = "processing" AND stale            (crash recovery: a previous
 *    execution claimed it and never finished — see PROCESSING_STALE_THRESHOLD_MS)
 *
 * Never matches "sent"/"failed" (terminal) or a "processing" row that's
 * still fresh (another execution genuinely, actively owns it right now).
 * Being a single conditional UPDATE — not read-then-write — is what makes
 * this safe across concurrent workers: two executions racing for the same
 * row can't both succeed, whichever case applies.
 */
async function markEmailProcessing(emailId: string, staleThresholdMs: number): Promise<boolean> {
  const staleBefore = new Date(Date.now() - staleThresholdMs);
  const result = await prisma.email.updateMany({
    where: {
      id: emailId,
      OR: [{ status: EmailStatus.scheduled }, { status: EmailStatus.processing, updatedAt: { lt: staleBefore } }],
    },
    data: { status: EmailStatus.processing },
  });
  return result.count === 1;
}

// Reverses markEmailProcessing when the send didn't go through — either
// blocked by the rate limiter, or an SMTP attempt that failed but still has
// retries left (see processEmailSend). Puts the email back to "scheduled"
// so a later execution (rescheduled BullMQ job, or a retry attempt) can
// claim it again. Guarded the same way: only reverts if still "processing",
// so it can't clobber a status set by some other concurrent execution.
async function revertEmailToScheduled(emailId: string): Promise<void> {
  await prisma.email.updateMany({
    where: { id: emailId, status: EmailStatus.processing },
    data: { status: EmailStatus.scheduled },
  });
}

async function markEmailSent(emailId: string): Promise<void> {
  await prisma.email.update({
    where: { id: emailId },
    data: {
      status: EmailStatus.sent,
      sentAt: new Date(),
      failedAt: null,
      failureReason: null,
    },
  });
}

/**
 * Permanently marks an email failed — only called once a failure is known
 * to be final (see isPermanentFailure / attempts-exhausted in
 * email.worker.ts). Uses updateMany (not update) so it's a safe no-op if
 * the email doesn't exist at all (the "email not found" permanent-failure
 * path has no row to update).
 */
export async function markEmailFailed(emailId: string, reason: string): Promise<void> {
  await prisma.email.updateMany({
    where: { id: emailId },
    data: {
      status: EmailStatus.failed,
      failedAt: new Date(),
      // Keep whatever ends up in the DB bounded — this is a human-readable
      // summary, not a place for a full stack trace.
      failureReason: reason.slice(0, 500),
    },
  });
}

export interface PaginationParams {
  page: number;
  limit: number;
}

export interface PaginationResult {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

function paginate<T extends PaginationParams>(params: T, total: number): PaginationResult {
  return {
    page: params.page,
    limit: params.limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / params.limit)),
  };
}

export interface PublicScheduledEmail {
  id: string;
  campaignId: string;
  recipient: string;
  subject: string;
  scheduledAt: Date;
  // "processing" is included alongside "scheduled" — a worker actively
  // claiming the row is still pending from the dashboard's point of view,
  // not sent/failed yet. Reported as-is rather than collapsed to
  // "scheduled" so the UI isn't told something false about the row's state.
  status: "scheduled" | "processing";
}

export interface ListScheduledEmailsParams extends PaginationParams {
  userId: string;
  campaignId?: string | undefined;
}

// Scoped exclusively through campaign.userId (Email has no userId of its
// own) — never accept a caller-supplied userId. A campaignId filter is
// ANDed into the same ownership-scoped where clause, so requesting another
// user's campaignId yields an empty result rather than leaking its emails.
export async function listScheduledEmailsForUser(
  params: ListScheduledEmailsParams,
): Promise<{ emails: PublicScheduledEmail[]; pagination: PaginationResult }> {
  const where = {
    status: { in: [EmailStatus.scheduled, EmailStatus.processing] },
    campaign: {
      userId: params.userId,
      ...(params.campaignId ? { id: params.campaignId } : {}),
    },
  };

  const [rows, total] = await Promise.all([
    prisma.email.findMany({
      where,
      orderBy: { scheduledAt: "asc" },
      skip: (params.page - 1) * params.limit,
      take: params.limit,
      select: {
        id: true,
        campaignId: true,
        recipient: true,
        scheduledAt: true,
        status: true,
        campaign: { select: { subject: true } },
      },
    }),
    prisma.email.count({ where }),
  ]);

  return {
    emails: rows.map((row) => ({
      id: row.id,
      campaignId: row.campaignId,
      recipient: row.recipient,
      subject: row.campaign.subject,
      scheduledAt: row.scheduledAt,
      status: row.status as "scheduled" | "processing",
    })),
    pagination: paginate(params, total),
  };
}

export interface PublicSentEmail {
  id: string;
  campaignId: string;
  recipient: string;
  subject: string;
  sentAt: Date | null;
  status: "sent" | "failed";
  failureReason: string | null;
}

export interface ListSentEmailsParams extends PaginationParams {
  userId: string;
  campaignId?: string | undefined;
  status?: "sent" | "failed" | undefined;
}

export async function listSentEmailsForUser(
  params: ListSentEmailsParams,
): Promise<{ emails: PublicSentEmail[]; pagination: PaginationResult }> {
  const statuses = params.status
    ? [params.status === "sent" ? EmailStatus.sent : EmailStatus.failed]
    : [EmailStatus.sent, EmailStatus.failed];

  const where = {
    status: { in: statuses },
    campaign: {
      userId: params.userId,
      ...(params.campaignId ? { id: params.campaignId } : {}),
    },
  };

  const [rows, total] = await Promise.all([
    prisma.email.findMany({
      where,
      // Most-recently-resolved first: sentAt for delivered mail, failedAt
      // for failures — falls back to updatedAt so both interleave sensibly.
      orderBy: { updatedAt: "desc" },
      skip: (params.page - 1) * params.limit,
      take: params.limit,
      select: {
        id: true,
        campaignId: true,
        recipient: true,
        sentAt: true,
        status: true,
        failureReason: true,
        campaign: { select: { subject: true } },
      },
    }),
    prisma.email.count({ where }),
  ]);

  return {
    emails: rows.map((row) => ({
      id: row.id,
      campaignId: row.campaignId,
      recipient: row.recipient,
      subject: row.campaign.subject,
      sentAt: row.sentAt,
      status: row.status as "sent" | "failed",
      failureReason: row.failureReason,
    })),
    pagination: paginate(params, total),
  };
}

export type ProcessEmailResult =
  | { outcome: "sent"; previewUrl: string | false }
  | { outcome: "skipped" }
  | { outcome: "rate_limited"; reason: "minimum_delay" | "hourly_limit"; nextAllowedAt: Date };

/**
 * The worker's single entry point: fetch the authoritative Email record,
 * claim it, check the sender's distributed rate limit, send it through
 * smtp.service.ts, and record the outcome.
 *
 * Deciding whether a thrown error is retryable vs permanent — and calling
 * markEmailFailed when it's final — is deliberately *not* done here. This
 * function only knows "the send failed"; whether BullMQ will retry the job
 * is a queue-policy fact (attempts remaining, backoff) that only
 * email.worker.ts has visibility into. So on failure this always reverts
 * the email back to "scheduled" (retryable) and rethrows; the worker
 * decides whether that revert is the end of the story (another attempt
 * will follow) or needs to be immediately overridden with markEmailFailed
 * (no attempts left / permanent).
 *
 * Reserving the rate-limit send slot happens immediately before the actual
 * SMTP call. If SMTP then fails, the reservation is *not* rolled back — the
 * sender's quota/delay clock still advances for a send that didn't
 * succeed. Documented trade-off, unchanged from Stage 6.
 *
 * `staleThresholdMs` defaults to the production PROCESSING_STALE_THRESHOLD_MS
 * (2 minutes) and only needs overriding by tests that also shorten a
 * worker's BullMQ `lockDuration` to exercise crash recovery without a real
 * multi-minute wait — see createEmailWorker's staleProcessingThresholdMs.
 *
 * Throws if the email doesn't exist, or if the SMTP send itself fails.
 */
export async function processEmailSend(
  emailId: string,
  staleThresholdMs: number = PROCESSING_STALE_THRESHOLD_MS,
): Promise<ProcessEmailResult> {
  const email = await loadEmailForSending(emailId);
  if (!email) {
    throw new NotFoundError(`Email ${emailId} not found`);
  }

  const claimed = await markEmailProcessing(email.id, staleThresholdMs);
  if (!claimed) {
    // Either a terminal state (sent/failed), or a still-fresh "processing"
    // claim genuinely owned by another concurrent execution. Not an error.
    return { outcome: "skipped" };
  }

  const rateLimit = await reserveSendSlot({
    senderId: email.senderId,
    delaySeconds: email.delaySeconds,
    hourlyLimit: email.hourlyLimit,
  });

  if (!rateLimit.allowed) {
    await revertEmailToScheduled(email.id);
    return {
      outcome: "rate_limited",
      reason: rateLimit.reason as "minimum_delay" | "hourly_limit",
      nextAllowedAt: rateLimit.nextAllowedAt,
    };
  }

  try {
    const info = await sendMail({
      from: email.senderDisplayName ? `"${email.senderDisplayName}" <${email.senderEmail}>` : email.senderEmail,
      to: email.recipient,
      subject: email.subject,
      text: email.body,
    });
    await markEmailSent(email.id);
    return { outcome: "sent", previewUrl: getPreviewUrl(info) };
  } catch (err) {
    await revertEmailToScheduled(email.id);
    throw err;
  }
}
