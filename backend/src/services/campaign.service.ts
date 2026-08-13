import { randomUUID } from "node:crypto";
import { CampaignStatus, EmailStatus } from "../../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { NotFoundError } from "../utils/errors.js";

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

  return {
    campaignId,
    totalRecipients: emailRows.length,
    status: CampaignStatus.scheduled,
  };
}

export interface PublicCampaign {
  id: string;
  senderId: string;
  subject: string;
  startTime: Date;
  delaySeconds: number;
  hourlyLimit: number;
  status: CampaignStatus;
  totalRecipients: number;
}

export async function listCampaignsForUser(userId: string): Promise<PublicCampaign[]> {
  const campaigns = await prisma.campaign.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      senderId: true,
      subject: true,
      startTime: true,
      delaySeconds: true,
      hourlyLimit: true,
      status: true,
      _count: { select: { emails: true } },
    },
  });

  return campaigns.map((campaign) => ({
    id: campaign.id,
    senderId: campaign.senderId,
    subject: campaign.subject,
    startTime: campaign.startTime,
    delaySeconds: campaign.delaySeconds,
    hourlyLimit: campaign.hourlyLimit,
    status: campaign.status,
    totalRecipients: campaign._count.emails,
  }));
}
