export type CampaignStatus = "draft" | "scheduled" | "completed" | "cancelled";

export interface Campaign {
  id: string;
  senderId: string;
  subject: string;
  startTime: string;
  delaySeconds: number;
  hourlyLimit: number;
  status: CampaignStatus;
  totalRecipients: number;
}

export interface CreateCampaignPayload {
  senderId: string;
  subject: string;
  body: string;
  recipients: string[];
  startTime: string;
  delaySeconds: number;
  hourlyLimit: number;
}

export interface CreateCampaignResult {
  campaignId: string;
  totalRecipients: number;
  status: CampaignStatus;
}
