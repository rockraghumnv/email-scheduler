import axios from "axios";
import type { User } from "../types/auth";

const API_URL: string = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

export const httpClient = axios.create({
  baseURL: `${API_URL}/api`,
  withCredentials: true,
});

export interface AuthCredentials {
  email: string;
  password: string;
}

export interface RegisterPayload extends AuthCredentials {
  name?: string;
}

export const authApi = {
  async login(payload: AuthCredentials): Promise<User> {
    const { data } = await httpClient.post<{ user: User }>("/auth/login", payload);
    return data.user;
  },

  async register(payload: RegisterPayload): Promise<User> {
    const { data } = await httpClient.post<{ user: User }>("/auth/register", payload);
    return data.user;
  },

  async logout(): Promise<void> {
    await httpClient.post("/auth/logout");
  },

  async me(): Promise<User> {
    const { data } = await httpClient.get<{ user: User }>("/auth/me");
    return data.user;
  },

  getGoogleLoginUrl(): string {
    return `${API_URL}/api/auth/google`;
  },
};
