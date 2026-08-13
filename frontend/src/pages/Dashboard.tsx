import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Clock3, LogOut, Plus, Send } from "lucide-react";
import { toast } from "sonner";
import { authApi } from "../services/auth.api";
import { AUTH_QUERY_KEY, useAuth } from "../hooks/useAuth";

interface ScheduledEmail {
  id: string;
  recipientName: string;
  scheduledFor: string;
  subject: string;
  snippet: string;
}

const SCHEDULED_EMAILS: ScheduledEmail[] = [
  {
    id: "1",
    recipientName: "John Smith",
    scheduledFor: "Tue 9:15:12 AM",
    subject: "Meeting follow-up - Scheduled",
    snippet: "Hi John, just wanted to follow up on our meeting…",
  },
  {
    id: "2",
    recipientName: "Olive",
    scheduledFor: "Thu 8:15:12 PM",
    subject: "Ramit, great to meet you - you'll love it",
    snippet: "Hi Olive, just wanted to follow up on our meeting…",
  },
  {
    id: "3",
    recipientName: "Priya Desai",
    scheduledFor: "Fri 10:00:00 AM",
    subject: "Proposal follow-up",
    snippet: "Hi Priya, sharing the updated proposal we discussed…",
  },
  {
    id: "4",
    recipientName: "Marcus Lee",
    scheduledFor: "Mon 2:30:00 PM",
    subject: "Welcome aboard!",
    snippet: "Hi Marcus, excited to have you onboard, here's what's next…",
  },
];

const SENT_COUNT = 785;

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

export default function Dashboard() {
  const [activeNav, setActiveNav] = useState<NavItem>("scheduled");
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

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
            <span>{SCHEDULED_EMAILS.length}</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveNav("sent")}
            className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm transition ${
              activeNav === "sent"
                ? "bg-green-50 font-medium text-neutral-900"
                : "text-neutral-600 hover:bg-neutral-50"
            }`}
          >
            <span className="flex items-center gap-2">
              <Send className="h-4 w-4" />
              Sent
            </span>
            <span>{SENT_COUNT}</span>
          </button>
        </nav>
      </aside>

      <main className="flex-1 px-8 py-6">
        {activeNav === "scheduled" ? (
          <ul className="divide-y divide-neutral-100">
            {SCHEDULED_EMAILS.map((email) => (
              <li key={email.id} className="flex items-center gap-4 py-4">
                <span className="w-40 shrink-0 text-sm text-neutral-700">To: {email.recipientName}</span>
                <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-amber-50 px-3 py-1 text-xs font-medium text-amber-700">
                  <Clock3 className="h-3.5 w-3.5" />
                  {email.scheduledFor}
                </span>
                <span className="min-w-0 truncate text-sm text-neutral-700">
                  <span className="font-medium text-neutral-900">{email.subject}</span>
                  {" - "}
                  {email.snippet}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-neutral-400">
            Sent emails will appear here.
          </div>
        )}
      </main>
    </div>
  );
}
