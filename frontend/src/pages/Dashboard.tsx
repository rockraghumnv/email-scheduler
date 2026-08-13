import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Clock3, LogOut, Plus, Send } from "lucide-react";
import { toast } from "sonner";
import { authApi } from "../services/auth.api";
import { campaignApi } from "../services/campaign.api";
import { AUTH_QUERY_KEY, useAuth } from "../hooks/useAuth";
import ComposeModal from "../components/ComposeModal";

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

function formatStartTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

export default function Dashboard() {
  const [activeNav, setActiveNav] = useState<NavItem>("scheduled");
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const [isComposeOpen, setIsComposeOpen] = useState(false);
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: campaigns, isPending: campaignsLoading } = useQuery({
    queryKey: ["campaigns"],
    queryFn: campaignApi.list,
  });

  const scheduledCampaigns = (campaigns ?? []).filter((campaign) => campaign.status === "scheduled");

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
            <span>{scheduledCampaigns.length}</span>
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
            <span>—</span>
          </button>
        </nav>
      </aside>

      <main className="flex-1 px-8 py-6">
        {activeNav === "scheduled" ? (
          campaignsLoading ? (
            <div className="flex h-full items-center justify-center text-sm text-neutral-400">Loading…</div>
          ) : scheduledCampaigns.length === 0 ? (
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
              {scheduledCampaigns.map((campaign) => (
                <li key={campaign.id} className="flex items-center gap-4 py-4">
                  <span className="w-40 shrink-0 text-sm text-neutral-700">
                    {campaign.totalRecipients} recipient{campaign.totalRecipients === 1 ? "" : "s"}
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-amber-50 px-3 py-1 text-xs font-medium text-amber-700">
                    <Clock3 className="h-3.5 w-3.5" />
                    {formatStartTime(campaign.startTime)}
                  </span>
                  <span className="min-w-0 truncate text-sm font-medium text-neutral-900">{campaign.subject}</span>
                </li>
              ))}
            </ul>
          )
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-neutral-400">
            Sent-email tracking isn't implemented yet.
          </div>
        )}
      </main>

      {isComposeOpen && <ComposeModal onClose={() => setIsComposeOpen(false)} />}
    </div>
  );
}
