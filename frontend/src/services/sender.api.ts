import { httpClient } from "./auth.api";
import type { Sender } from "../types/sender";

export const senderApi = {
  async list(): Promise<Sender[]> {
    const { data } = await httpClient.get<{ senders: Sender[] }>("/senders");
    return data.senders;
  },
};
