import { randomUUID } from "node:crypto";
import { CampaignStatus, EmailStatus } from "../../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { scheduleCampaignEmails } from "./scheduler.service.js";
import { HttpError, NotFoundError } from "../utils/errors.js";

export interface CreateCampaignInput {
  userId: string;
  senderId: string;
  subject: string;
  body: string;
  recipients: string[];
  startTime: Date;
  delaySeconds: number;
  hourlyLimit: number;
}

export interface CreatedCampaign {
  campaignId: string;
  totalRecipients: number;
  status: CampaignStatus;
}

export async function createCampaign(input: CreateCampaignInput): Promise<CreatedCampaign> {
  const sender = await prisma.sender.findFirst({
    where: { id: input.senderId, userId: input.userId },
    select: { id: true },
  });
  if (!sender) {
    // Same 404 whether the sender doesn't exist or just isn't this user's —
    // avoids leaking whether another user's sender id exists.
    throw new NotFoundError("Sender not found");
  }

  // Recipients arrive already trimmed/lowercased by the request schema, so a
  // Set is enough to de-duplicate; duplicates are dropped rather than rejected.
  const uniqueRecipients = Array.from(new Set(input.recipients));

  const campaignId = randomUUID();
  const emailRows = uniqueRecipients.map((recipient, index) => ({
    id: randomUUID(),
    campaignId,
    recipient,
    // Naive even-spacing for now: recipient[i] = startTime + i * delaySeconds.
    // hourlyLimit is persisted but not yet applied to this calculation — the
    // later scheduling/rate-limiting stage will need to redistribute these
    // timestamps (or the BullMQ job delays) once it accounts for the limit.
    scheduledAt: new Date(input.startTime.getTime() + index * input.delaySeconds * 1000),
    status: EmailStatus.scheduled,
  }));

  // PostgreSQL is the source of truth and must commit before anything is
  // queued — a job referencing an email that doesn't exist is worse than a
  // committed email that isn't queued yet (the latter is retryable via
  // scheduleCampaignEmails, using the same deterministic job ids).
  await prisma.$transaction(async (tx) => {
    await tx.campaign.create({
      data: {
        id: campaignId,
        userId: input.userId,
        senderId: input.senderId,
        subject: input.subject,
        body: input.body,
        startTime: input.startTime,
        delaySeconds: input.delaySeconds,
        hourlyLimit: input.hourlyLimit,
        status: CampaignStatus.scheduled,
      },
    });

    await tx.email.createMany({ data: emailRows });
  });

  try {
    await scheduleCampaignEmails(campaignId, emailRows);
  } catch (err) {
    // The campaign and its emails are already committed — they are not lost,
    // and re-calling scheduleCampaignEmails for this campaignId later is
    // safe (deterministic job ids). What we must not do is respond 201 as if
    // scheduling succeeded, so this is surfaced as a distinct failure.
    console.error(
      `Failed to provision BullMQ jobs for campaign ${campaignId} (${emailRows.length} emails):`,
      err,
    );
    throw new HttpError(
      502,
      "Campaign was saved but could not be scheduled. Please retry; your campaign has not been lost.",
    );
  }

  return {
    campaignId,
    totalRecipients: emailRows.length,
    status: CampaignStatus.scheduled,
  };
}

export interface PublicCampaign {
  id: string;
  senderId: string;
  sender: { id: string; email: string; displayName: string | null };
  subject: string;
  startTime: Date;
  delaySeconds: number;
  hourlyLimit: number;
  status: CampaignStatus;
  totalRecipients: number;
}

export interface ListCampaignsParams {
  userId: string;
  page: number;
  limit: number;
}

export interface CampaignPagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export async function listCampaignsForUser(
  params: ListCampaignsParams,
): Promise<{ campaigns: PublicCampaign[]; pagination: CampaignPagination }> {
  const where = { userId: params.userId };

  const [campaigns, total] = await Promise.all([
    prisma.campaign.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (params.page - 1) * params.limit,
      take: params.limit,
      select: {
        id: true,
        senderId: true,
        subject: true,
        startTime: true,
        delaySeconds: true,
        hourlyLimit: true,
        status: true,
        sender: { select: { id: true, email: true, displayName: true } },
        _count: { select: { emails: true } },
      },
    }),
    prisma.campaign.count({ where }),
  ]);

  return {
    campaigns: campaigns.map((campaign) => ({
      id: campaign.id,
      senderId: campaign.senderId,
      sender: campaign.sender,
      subject: campaign.subject,
      startTime: campaign.startTime,
      delaySeconds: campaign.delaySeconds,
      hourlyLimit: campaign.hourlyLimit,
      status: campaign.status,
      totalRecipients: campaign._count.emails,
    })),
    pagination: {
      page: params.page,
      limit: params.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / params.limit)),
    },
  };
}
