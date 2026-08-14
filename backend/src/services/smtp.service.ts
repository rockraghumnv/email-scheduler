import nodemailer from "nodemailer";
import type { SendMailOptions } from "nodemailer";
import { env } from "../config/env.js";

// Single lazily-created transporter, reused for every send — mirrors how
// lib/prisma.ts and lib/redis.ts hold one shared client rather than opening
// a new connection per call. The future BullMQ worker should go through the
// functions this module exports rather than importing `nodemailer` itself.
let transporter: ReturnType<typeof nodemailer.createTransport> | undefined;

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.ETHEREAL_HOST,
      port: env.ETHEREAL_PORT,
      secure: env.ETHEREAL_SECURE,
      auth: {
        user: env.ETHEREAL_USER,
        pass: env.ETHEREAL_PASSWORD,
      },
    });
  }
  return transporter;
}

/**
 * Confirms the configured SMTP credentials can actually authenticate.
 * Never throws — returns false and logs (without the password) on failure,
 * since SMTP isn't a hard startup dependency for this project yet.
 */
export async function verifySmtpConnection(): Promise<boolean> {
  try {
    await getTransporter().verify();
    console.log(`SMTP connection verified (host=${env.ETHEREAL_HOST}, port=${env.ETHEREAL_PORT}, user=${env.ETHEREAL_USER})`);
    return true;
  } catch (err) {
    console.error(
      `SMTP connection verification failed (host=${env.ETHEREAL_HOST}, port=${env.ETHEREAL_PORT}):`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/**
 * Reusable send abstraction — this, not the transporter itself, is what the
 * BullMQ worker calls (see email.service.ts).
 */
export async function sendMail(options: SendMailOptions) {
  return getTransporter().sendMail(options);
}

/**
 * Extracts Ethereal's preview URL from a sendMail() result. Kept here so
 * callers (email.service.ts, the worker) never need to import `nodemailer`
 * directly — all Nodemailer/Ethereal specifics stay in this module.
 */
export function getPreviewUrl(info: Awaited<ReturnType<typeof sendMail>>): string | false {
  return nodemailer.getTestMessageUrl(info);
}

export interface TestEmailResult {
  messageId: string;
  previewUrl: string | false;
}

const DEFAULT_TEST_RECIPIENT = "test-recipient@ethereal.email";

/**
 * Development-only helper: sends one message through the configured
 * Ethereal account and returns Nodemailer's preview URL for it. Not used by
 * the (future) worker — this exists purely to confirm the SMTP
 * infrastructure works end to end without involving BullMQ.
 */
export async function sendTestEmail(
  overrides: { to?: string; subject?: string; text?: string } = {},
): Promise<TestEmailResult> {
  const info = await sendMail({
    from: `"Email Scheduler Dev" <${env.ETHEREAL_USER}>`,
    to: overrides.to ?? DEFAULT_TEST_RECIPIENT,
    subject: overrides.subject ?? "Email Scheduler — SMTP test",
    text: overrides.text ?? "This is a test email confirming Ethereal SMTP is configured correctly.",
  });

  return {
    messageId: info.messageId,
    previewUrl: getPreviewUrl(info),
  };
}
