import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import axios from "axios";
import { X } from "lucide-react";
import { toast } from "sonner";
import { senderApi } from "../services/sender.api";
import { campaignApi } from "../services/campaign.api";

interface ComposeModalProps {
  onClose: () => void;
}

function parseRecipients(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(/[\s,]+/)
        .map((email) => email.trim().toLowerCase())
        .filter((email) => email.length > 0),
    ),
  );
}

function extractErrorMessage(error: unknown): string {
  if (axios.isAxiosError<{ error?: string }>(error) && error.response?.data.error) {
    return error.response.data.error;
  }
  return "Unable to schedule campaign. Please try again.";
}

export default function ComposeModal({ onClose }: ComposeModalProps) {
  const queryClient = useQueryClient();
  const { data: senders, isPending: sendersLoading } = useQuery({
    queryKey: ["senders"],
    queryFn: senderApi.list,
  });

  const [senderId, setSenderId] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [recipientsText, setRecipientsText] = useState("");
  const [startTime, setStartTime] = useState("");
  const [delaySeconds, setDelaySeconds] = useState(2);
  const [hourlyLimit, setHourlyLimit] = useState(200);

  const createMutation = useMutation({
    mutationFn: campaignApi.create,
    onSuccess: (result) => {
      toast.success(
        `Campaign scheduled for ${result.totalRecipients} recipient${result.totalRecipients === 1 ? "" : "s"}`,
      );
      queryClient.invalidateQueries({ queryKey: ["campaigns"] });
      onClose();
    },
    onError: (error) => {
      toast.error(extractErrorMessage(error));
    },
  });

  function handleSubmit(event: FormEvent) {
    event.preventDefault();

    const recipients = parseRecipients(recipientsText);
    if (recipients.length === 0) {
      toast.error("Add at least one recipient.");
      return;
    }
    if (!startTime) {
      toast.error("Choose a start time.");
      return;
    }

    createMutation.mutate({
      senderId,
      subject,
      body,
      recipients,
      startTime: new Date(startTime).toISOString(),
      delaySeconds,
      hourlyLimit,
    });
  }

  const noSenders = !sendersLoading && (senders?.length ?? 0) === 0;

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/40 px-4">
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-6 shadow-lg">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-neutral-900">Compose campaign</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1 text-neutral-400 hover:bg-neutral-100"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {noSenders && (
          <p className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700">
            You don't have any sender identities yet, so a campaign can't be scheduled.
          </p>
        )}

        <form onSubmit={handleSubmit} className="space-y-3">
          <select
            required
            value={senderId}
            onChange={(event) => setSenderId(event.target.value)}
            disabled={noSenders}
            className="w-full rounded-lg bg-neutral-100 px-4 py-3 text-sm text-neutral-800 focus:outline-none focus:ring-2 focus:ring-green-500 disabled:opacity-60"
          >
            <option value="" disabled>
              {sendersLoading ? "Loading senders..." : "Select a sender"}
            </option>
            {senders?.map((sender) => (
              <option key={sender.id} value={sender.id}>
                {sender.displayName ? `${sender.displayName} <${sender.email}>` : sender.email}
              </option>
            ))}
          </select>

          <input
            type="text"
            required
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            placeholder="Subject"
            className="w-full rounded-lg bg-neutral-100 px-4 py-3 text-sm text-neutral-800 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-green-500"
          />

          <textarea
            required
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder="Body"
            rows={4}
            className="w-full rounded-lg bg-neutral-100 px-4 py-3 text-sm text-neutral-800 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-green-500"
          />

          <textarea
            required
            value={recipientsText}
            onChange={(event) => setRecipientsText(event.target.value)}
            placeholder="Recipients — separate with commas, spaces, or new lines"
            rows={3}
            className="w-full rounded-lg bg-neutral-100 px-4 py-3 text-sm text-neutral-800 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-green-500"
          />

          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs text-neutral-500">
              Start time
              <input
                type="datetime-local"
                required
                value={startTime}
                onChange={(event) => setStartTime(event.target.value)}
                className="mt-1 w-full rounded-lg bg-neutral-100 px-3 py-2 text-sm text-neutral-800 focus:outline-none focus:ring-2 focus:ring-green-500"
              />
            </label>
            <label className="text-xs text-neutral-500">
              Delay between emails (sec)
              <input
                type="number"
                min={0}
                required
                value={delaySeconds}
                onChange={(event) => setDelaySeconds(Number(event.target.value))}
                className="mt-1 w-full rounded-lg bg-neutral-100 px-3 py-2 text-sm text-neutral-800 focus:outline-none focus:ring-2 focus:ring-green-500"
              />
            </label>
            <label className="col-span-2 text-xs text-neutral-500">
              Hourly limit
              <input
                type="number"
                min={1}
                required
                value={hourlyLimit}
                onChange={(event) => setHourlyLimit(Number(event.target.value))}
                className="mt-1 w-full rounded-lg bg-neutral-100 px-3 py-2 text-sm text-neutral-800 focus:outline-none focus:ring-2 focus:ring-green-500"
              />
            </label>
          </div>

          <button
            type="submit"
            disabled={createMutation.isPending || noSenders}
            className="w-full rounded-full bg-green-600 py-3 text-sm font-semibold text-white transition hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {createMutation.isPending ? "Scheduling..." : "Schedule campaign"}
          </button>
        </form>
      </div>
    </div>
  );
}
