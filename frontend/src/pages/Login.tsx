import { useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import axios from "axios";
import { toast } from "sonner";
import { authApi } from "../services/auth.api";
import { AUTH_QUERY_KEY } from "../hooks/useAuth";

type Mode = "login" | "register";

function GoogleIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#FFC107"
        d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.6 6.1 29.6 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.7-.4-3.5z"
      />
      <path
        fill="#FF3D00"
        d="M6.3 14.7l6.6 4.8C14.6 15.9 18.9 13 24 13c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.6 6.1 29.6 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.5 0 10.5-2.1 14.3-5.6l-6.6-5.6C29.6 34.7 27 35.5 24 35.5c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.6 39.6 16.3 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.2 4.3-4.1 5.8l6.6 5.6C41.9 36 44 30.5 44 24c0-1.3-.1-2.7-.4-3.5z"
      />
    </svg>
  );
}

function extractErrorMessage(error: unknown, mode: Mode): string {
  if (axios.isAxiosError<{ error?: string }>(error) && error.response?.data.error) {
    return error.response.data.error;
  }
  return mode === "login" ? "Unable to log in. Please try again." : "Unable to create account. Please try again.";
}

export default function Login() {
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();

  const googleError = searchParams.get("error") === "google_auth_failed";

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setIsSubmitting(true);
    try {
      if (mode === "login") {
        await authApi.login({ email, password });
      } else {
        await authApi.register({ email, password, name: name || undefined });
      }
      await queryClient.invalidateQueries({ queryKey: AUTH_QUERY_KEY });
      navigate("/dashboard", { replace: true });
    } catch (error) {
      toast.error(extractErrorMessage(error, mode));
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleGoogleLogin() {
    window.location.href = authApi.getGoogleLoginUrl();
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-50 px-4">
      <div className="w-full max-w-md rounded-2xl border border-neutral-200 bg-white p-8 shadow-sm">
        <h1 className="mb-6 text-center text-3xl font-bold text-neutral-900">
          {mode === "login" ? "Login" : "Sign up"}
        </h1>

        {googleError && (
          <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-center text-sm text-red-600">
            Google sign-in failed. Please try again.
          </p>
        )}

        <button
          type="button"
          onClick={handleGoogleLogin}
          className="flex w-full items-center justify-center gap-2 rounded-full bg-green-50 py-3 text-sm font-medium text-neutral-800 transition hover:bg-green-100"
        >
          <GoogleIcon />
          Login with Google
        </button>

        <div className="my-6 flex items-center gap-3">
          <span className="h-px flex-1 bg-neutral-200" />
          <span className="text-xs text-neutral-400">
            {mode === "login" ? "or sign up through email" : "or fill in your details"}
          </span>
          <span className="h-px flex-1 bg-neutral-200" />
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          {mode === "register" && (
            <input
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Full name"
              className="w-full rounded-lg bg-neutral-100 px-4 py-3 text-sm text-neutral-800 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-green-500"
            />
          )}
          <input
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="Email ID"
            className="w-full rounded-lg bg-neutral-100 px-4 py-3 text-sm text-neutral-800 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-green-500"
          />
          <input
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Password"
            className="w-full rounded-lg bg-neutral-100 px-4 py-3 text-sm text-neutral-800 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-green-500"
          />

          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full rounded-full bg-green-600 py-3 text-sm font-semibold text-white transition hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSubmitting ? "Please wait..." : mode === "login" ? "Login" : "Create account"}
          </button>
        </form>

        <p className="mt-5 text-center text-sm text-neutral-500">
          {mode === "login" ? "Don't have an account? " : "Already have an account? "}
          <button
            type="button"
            onClick={() => setMode(mode === "login" ? "register" : "login")}
            className="font-medium text-green-700 hover:underline"
          >
            {mode === "login" ? "Sign up" : "Log in"}
          </button>
        </p>
      </div>
    </div>
  );
}
