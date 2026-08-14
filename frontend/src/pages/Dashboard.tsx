import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, ChevronDown, Clock3, Loader2, LogOut, Plus, Send, XCircle } from "lucide-react";
import { toast } from "sonner";
import { authApi } from "../services/auth.api";
import { emailApi } from "../services/email.api";
import { useAuth } from "../hooks/useAuth";
import { AUTH_QUERY_KEY, SCHEDULED_EMAILS_QUERY_KEY, SENT_EMAILS_QUERY_KEY } from "../lib/queryKeys";
import { getErrorMessage } from "../utils/errors";
import ComposeModal from "../components/ComposeModal";
import type { ScheduledEmail, SentEmail } from "../types/email";

type NavItem = "scheduled" | "sent";

function getInitials(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "?";
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

function ScheduledStatusBadge({ status }: { status: ScheduledEmail["status"] }) {
  if (status === "processing") {
    return (
      <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Sending
      </span>
    );
  }
  return (
    <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-amber-50 px-3 py-1 text-xs font-medium text-amber-700">
      <Clock3 className="h-3.5 w-3.5" />
      Scheduled
    </span>
  );
}

function SentStatusBadge({ email }: { email: SentEmail }) {
  if (email.status === "failed") {
    return (
      <span
        className="flex shrink-0 items-center gap-1.5 rounded-full bg-red-50 px-3 py-1 text-xs font-medium text-red-700"
        title={email.failureReason ?? undefined}
      >
        <XCircle className="h-3.5 w-3.5" />
        Failed
      </span>
    );
  }
  return (
    <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-green-50 px-3 py-1 text-xs font-medium text-green-700">
      <CheckCircle2 className="h-3.5 w-3.5" />
      Sent
    </span>
  );
}

function CenteredMessage({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center text-sm text-neutral-400">{children}</div>;
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-neutral-500">
      <AlertTriangle className="h-6 w-6 text-red-400" />
      <p>{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-full border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 transition hover:bg-neutral-50"
      >
        Try again
      </button>
    </div>
  );
}

export default function Dashboard() {
  const [activeNav, setActiveNav] = useState<NavItem>("scheduled");
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const [isComposeOpen, setIsComposeOpen] = useState(false);
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const scheduledQuery = useQuery({
    queryKey: SCHEDULED_EMAILS_QUERY_KEY,
    queryFn: () => emailApi.listScheduled(),
  });
  const sentQuery = useQuery({
    queryKey: SENT_EMAILS_QUERY_KEY,
    queryFn: () => emailApi.listSent(),
  });

  const scheduledEmails = scheduledQuery.data?.emails ?? [];
  const sentEmails = sentQuery.data?.emails ?? [];

  async function handleLogout() {
    try {
      await authApi.logout();
    } catch {
      toast.error("Something went wrong while logging out.");
    } finally {
      queryClient.removeQueries({ queryKey: AUTH_QUERY_KEY });
      navigate("/login", { replace: true });
    }
  }

  const initials = getInitials(user?.name ?? user?.email ?? "?");

  return (
    <div className="flex min-h-screen bg-white text-neutral-900">
      <aside className="flex w-64 flex-col border-r border-neutral-200 px-4 py-5">
        <div className="relative mb-6">
          <button
            type="button"
            onClick={() => setShowProfileMenu((value) => !value)}
            className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-neutral-50"
          >
            {user?.avatarUrl ? (
              <img src={user.avatarUrl} alt="" className="h-9 w-9 rounded-full object-cover" />
            ) : (
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-green-100 text-sm font-semibold text-green-700">
                {initials}
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-neutral-900">
                {user?.name ?? "Your account"}
              </span>
              <span className="block truncate text-xs text-neutral-400">{user?.email}</span>
            </span>
            <ChevronDown className="h-4 w-4 shrink-0 text-neutral-400" />
          </button>

          {showProfileMenu && (
            <div className="absolute left-0 right-0 top-full z-10 mt-1 rounded-lg border border-neutral-200 bg-white py-1 shadow-md">
              <button
                type="button"
                onClick={handleLogout}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-50"
              >
                <LogOut className="h-4 w-4" />
                Log out
              </button>
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={() => setIsComposeOpen(true)}
          className="mb-6 flex items-center justify-center gap-2 rounded-full border border-green-600 py-2.5 text-sm font-medium text-green-700 transition hover:bg-green-50"
        >
          <Plus className="h-4 w-4" />
          Compose
        </button>

        <p className="mb-2 px-2 text-xs font-medium tracking-wide text-neutral-400">CORE</p>

        <nav className="space-y-1">
          <button
            type="button"
            onClick={() => setActiveNav("scheduled")}
            className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm transition ${
              activeNav === "scheduled"
                ? "bg-green-50 font-medium text-neutral-900"
                : "text-neutral-600 hover:bg-neutral-50"
            }`}
          >
            <span className="flex items-center gap-2">
              <Clock3 className="h-4 w-4" />
              Scheduled
            </span>
            <span>{scheduledQuery.isPending ? "—" : scheduledQuery.data?.pagination.total ?? 0}</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveNav("sent")}
            className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm transition ${
              activeNav === "sent" ? "bg-green-50 font-medium text-neutral-900" : "text-neutral-600 hover:bg-neutral-50"
            }`}
          >
            <span className="flex items-center gap-2">
              <Send className="h-4 w-4" />
              Sent
            </span>
            <span>{sentQuery.isPending ? "—" : sentQuery.data?.pagination.total ?? 0}</span>
          </button>
        </nav>
      </aside>

      <main className="flex-1 px-8 py-6">
        {activeNav === "scheduled" ? (
          scheduledQuery.isPending ? (
            <CenteredMessage>Loading…</CenteredMessage>
          ) : scheduledQuery.isError ? (
            <ErrorState
              message={getErrorMessage(scheduledQuery.error, "Couldn't load your scheduled emails.")}
              onRetry={() => void scheduledQuery.refetch()}
            />
          ) : scheduledEmails.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-neutral-400">
              <p>No campaigns scheduled yet.</p>
              <button
                type="button"
                onClick={() => setIsComposeOpen(true)}
                className="rounded-full border border-green-600 px-4 py-2 text-sm font-medium text-green-700 transition hover:bg-green-50"
              >
                Compose your first campaign
              </button>
            </div>
          ) : (
            <ul className="divide-y divide-neutral-100">
              {scheduledEmails.map((email) => (
                <li key={email.id} className="flex items-center gap-4 py-4">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-neutral-900">
                    {email.recipient}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-neutral-600">{email.subject}</span>
                  <span className="shrink-0 text-xs text-neutral-400">{formatDateTime(email.scheduledAt)}</span>
                  <ScheduledStatusBadge status={email.status} />
                </li>
              ))}
            </ul>
          )
        ) : sentQuery.isPending ? (
          <CenteredMessage>Loading…</CenteredMessage>
        ) : sentQuery.isError ? (
          <ErrorState
            message={getErrorMessage(sentQuery.error, "Couldn't load your sent emails.")}
            onRetry={() => void sentQuery.refetch()}
          />
        ) : sentEmails.length === 0 ? (
          <CenteredMessage>Nothing sent yet.</CenteredMessage>
        ) : (
          <ul className="divide-y divide-neutral-100">
            {sentEmails.map((email) => (
              <li key={email.id} className="flex items-center gap-4 py-4">
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-neutral-900">
                  {email.recipient}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-neutral-600">{email.subject}</span>
                <span className="shrink-0 text-xs text-neutral-400">
                  {email.sentAt ? formatDateTime(email.sentAt) : "—"}
                </span>
                <SentStatusBadge email={email} />
              </li>
            ))}
          </ul>
        )}
      </main>

      {isComposeOpen && <ComposeModal onClose={() => setIsComposeOpen(false)} />}
    </div>
  );
}
