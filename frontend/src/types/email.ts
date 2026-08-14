export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface ScheduledEmail {
  id: string;
  campaignId: string;
  recipient: string;
  subject: string;
  scheduledAt: string;
  status: "scheduled" | "processing";
}

export interface SentEmail {
  id: string;
  campaignId: string;
  recipient: string;
  subject: string;
  sentAt: string | null;
  status: "sent" | "failed";
  failureReason: string | null;
}
