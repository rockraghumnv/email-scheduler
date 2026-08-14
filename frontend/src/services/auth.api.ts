import axios from "axios";
import { queryClient } from "../lib/queryClient";
import { AUTH_QUERY_KEY } from "../lib/queryKeys";
import type { User } from "../types/auth";

const API_URL: string = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

export const httpClient = axios.create({
  baseURL: `${API_URL}/api`,
  withCredentials: true,
});

// Any request coming back 401 means the session is no longer valid (expired,
// logged out elsewhere, etc). Drop the cached user rather than navigating
// directly — ProtectedRoute already redirects to /login whenever `useAuth()`
// has no user, so this just needs to make that become true. A no-op when
// the 401 came from an already-anticipated case (e.g. a login attempt with
// wrong credentials, where the caller's own try/catch shows the real error).
httpClient.interceptors.response.use(
  (response) => response,
  (error: unknown) => {
    if (axios.isAxiosError(error) && error.response?.status === 401) {
      queryClient.removeQueries({ queryKey: AUTH_QUERY_KEY });
    }
    return Promise.reject(error);
  },
);

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
