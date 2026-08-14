import { NotFoundError } from "./errors.js";

/**
 * Shared policy for safely handling at-least-once job execution: how long a
 * "processing" claim is trusted before it's treated as abandoned, and which
 * failures are worth retrying at all.
 *
 * -----------------------------------------------------------------------
 * Known limitation — the SMTP crash window (explicitly not solved here):
 *
 *   worker sends email -> Ethereal accepts it -> worker crashes before the
 *   DB write that records status="sent"
 *
 * From this system's point of view, "Ethereal accepted the message" and
 * "we never heard back" are indistinguishable once the process is dead —
 * there is no provider-side idempotency key or send-receipt we can query
 * afterward to ask Ethereal "did you already get this one?". When the job
 * is later recovered (see PROCESSING_STALE_THRESHOLD_MS below) and retried,
 * it may genuinely be re-sent even though the original send succeeded.
 *
 * This module gives at-least-once *execution* (no job is silently dropped)
 * with duplicate-*send* protection only for the ordinary cases (already
 * "sent" in the DB, or a still-fresh "processing" claim actively owned by
 * another worker). It does not, and cannot on this stack, guarantee
 * exactly-once delivery. That requires either a provider idempotency key
 * (Ethereal has none) or an outbox/reconciliation step, which is
 * out of scope for this stage.
 * -----------------------------------------------------------------------
 */

// How long an email may sit in "processing" before a *different* execution
// is allowed to reclaim it. Must comfortably exceed BullMQ's worker lock
// duration (30s default) so we never race a worker that's still genuinely,
// actively sending — only ever reclaim one that's actually gone.
export const PROCESSING_STALE_THRESHOLD_MS = 2 * 60 * 1000;

/**
 * Decides whether a failure is worth retrying.
 *
 * Permanent (no retry, ever): the email record doesn't exist, or the SMTP
 * server gave a definitive 5xx rejection (RFC 5321 — permanent failure,
 * e.g. bad recipient address). Retrying either can never succeed.
 *
 * Retryable (default): everything else, including connection-level errors
 * (timeouts, ECONNREFUSED, DNS hiccups) and SMTP 4xx responses (temporary
 * failure, e.g. "mailbox busy" — RFC 5321 says try again later). Unknown
 * errors default to retryable rather than permanent: giving up early on an
 * email we *could* have sent is worse than one extra retry on an email we
 * genuinely can't.
 */
export function isPermanentFailure(err: unknown): boolean {
  if (err instanceof NotFoundError) {
    return true;
  }
  if (err instanceof Error) {
    const responseCode = (err as { responseCode?: unknown }).responseCode;
    if (typeof responseCode === "number") {
      return responseCode >= 500 && responseCode < 600;
    }
  }
  return false;
}
