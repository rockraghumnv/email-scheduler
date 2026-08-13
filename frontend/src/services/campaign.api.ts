import { httpClient } from "./auth.api";
import type { Campaign, CreateCampaignPayload, CreateCampaignResult } from "../types/campaign";

export const campaignApi = {
  async list(): Promise<Campaign[]> {
    const { data } = await httpClient.get<{ campaigns: Campaign[] }>("/campaigns");
    return data.campaigns;
  },

  async create(payload: CreateCampaignPayload): Promise<CreateCampaignResult> {
    const { data } = await httpClient.post<CreateCampaignResult>("/campaigns", payload);
    return data;
  },
};
