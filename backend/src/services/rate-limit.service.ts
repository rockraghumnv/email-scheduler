import { ioredisConnection } from "../lib/redis.js";

export type RateLimitReason = "allowed" | "minimum_delay" | "hourly_limit";

export interface RateLimitResult {
  allowed: boolean;
  reason: RateLimitReason;
  /** When this sender is next eligible. Equal to `now` when allowed. */
  nextAllowedAt: Date;
}

// Cleanup safety net only — correctness of the minimum-delay check never
// depends on this TTL (a missing key just means "no prior send on record").
const LAST_SEND_KEY_TTL_SECONDS = 60 * 60 * 24;
// Extra headroom past the hour boundary so a counter isn't evicted by clock
// skew a moment before the window it describes has actually finished.
const HOUR_KEY_TTL_BUFFER_SECONDS = 60;

function lastSendKey(senderId: string): string {
  return `sender:${senderId}:last-send`;
}

function hourWindowId(at: Date): string {
  // e.g. 2026-08-13T23:45:12.345Z -> "2026081323"
  return at.toISOString().slice(0, 13).replace(/[-T]/g, "");
}

function hourKey(senderId: string, at: Date): string {
  return `sender:${senderId}:hour:${hourWindowId(at)}`;
}

function startOfHour(at: Date): number {
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), at.getUTCHours());
}

function startOfNextHour(at: Date): Date {
  return new Date(startOfHour(at) + 60 * 60 * 1000);
}

function secondsUntilHourExpiry(at: Date): number {
  const windowEndMs = startOfHour(at) + 60 * 60 * 1000;
  return Math.ceil((windowEndMs - at.getTime()) / 1000) + HOUR_KEY_TTL_BUFFER_SECONDS;
}

/**
 * Atomically checks and, if eligible, reserves a send slot for `senderId`
 * against that sender's shared Redis state — coordinated across every
 * worker process, not process-local. Backed by a single Lua script
 * (`reserveSendSlot` in lib/redis.ts) so the delay check, quota check, and
 * reservation happen as one indivisible step; no worker can observe a stale
 * count between "check" and "increment".
 *
 * Multi-campaign-per-sender policy (see Stage 6 report for the full
 * reasoning): `delaySeconds`/`hourlyLimit` are the *specific email's own
 * campaign* settings, evaluated against the sender's single shared counters.
 * Campaigns don't yet have a "completed" state, so there's no reliable way
 * to know which of a sender's campaigns are "still active" in order to take
 * a cross-campaign min/max — using each email's own campaign values keeps
 * the sender's total strictly bounded (no campaign can push the sender past
 * its own configured limit) without that unavailable information.
 */
export async function reserveSendSlot(params: {
  senderId: string;
  delaySeconds: number;
  hourlyLimit: number;
}): Promise<RateLimitResult> {
  const now = new Date();

  const [allowed, reason, meta] = await ioredisConnection.reserveSendSlot(
    lastSendKey(params.senderId),
    hourKey(params.senderId, now),
    now.getTime(),
    params.delaySeconds * 1000,
    params.hourlyLimit,
    secondsUntilHourExpiry(now),
    LAST_SEND_KEY_TTL_SECONDS,
  );

  if (allowed === 1) {
    return { allowed: true, reason: "allowed", nextAllowedAt: now };
  }

  if (reason === "minimum_delay") {
    return { allowed: false, reason: "minimum_delay", nextAllowedAt: new Date(meta) };
  }

  return { allowed: false, reason: "hourly_limit", nextAllowedAt: startOfNextHour(now) };
}
