import { httpClient } from "./auth.api";
import type { Pagination, ScheduledEmail, SentEmail } from "../types/email";

export interface ListEmailsParams {
  page?: number;
  limit?: number;
  campaignId?: string;
}

export interface ListSentEmailsParams extends ListEmailsParams {
  status?: "sent" | "failed";
}

export const emailApi = {
  async listScheduled(params: ListEmailsParams = {}): Promise<{ emails: ScheduledEmail[]; pagination: Pagination }> {
    const { data } = await httpClient.get<{ emails: ScheduledEmail[]; pagination: Pagination }>(
      "/emails/scheduled",
      { params },
    );
    return data;
  },

  async listSent(params: ListSentEmailsParams = {}): Promise<{ emails: SentEmail[]; pagination: Pagination }> {
    const { data } = await httpClient.get<{ emails: SentEmail[]; pagination: Pagination }>("/emails/sent", {
      params,
    });
    return data;
  },
};
