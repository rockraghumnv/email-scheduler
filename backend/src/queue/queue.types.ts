export const EMAIL_JOB_NAME = "send-email";

// Kept deliberately small: PostgreSQL is the source of truth for the email's
// business data (recipient, subject, body, ...). The worker (next stage) is
// expected to look the email up by id rather than trust duplicated data here.
// campaignId is included because it's genuinely useful for logging/debugging
// a job without an extra query, not because it's needed to process the job.
export interface EmailJobData {
  emailId: string;
  campaignId: string;
}

export interface EmailJobRequest {
  emailId: string;
  campaignId: string;
  delayMs: number;
}
