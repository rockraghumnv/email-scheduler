import type { RequestHandler } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import { createCampaign, listCampaignsForUser } from "../services/campaign.service.js";
import { UnauthorizedError } from "../utils/errors.js";

const createCampaignSchema = z
  .object({
    senderId: z.string().uuid("senderId must be a valid id"),
    subject: z.string().trim().min(1, "Subject is required").max(300),
    body: z.string().trim().min(1, "Body is required"),
    recipients: z
      .array(z.string().trim().toLowerCase().email("Invalid recipient email address"))
      .min(1, "At least one recipient is required"),
    startTime: z.coerce.date(),
    delaySeconds: z
      .number()
      .int()
      .min(env.MIN_EMAIL_DELAY, `delaySeconds must be at least ${env.MIN_EMAIL_DELAY}`),
    hourlyLimit: z
      .number()
      .int()
      .positive("hourlyLimit must be greater than zero")
      .max(env.MAX_EMAILS_PER_HOUR, `hourlyLimit cannot exceed ${env.MAX_EMAILS_PER_HOUR}`),
  })
  .refine((data) => !Number.isNaN(data.startTime.getTime()), {
    message: "startTime must be a valid date",
    path: ["startTime"],
  });

export const createCampaignHandler: RequestHandler = async (req, res, next) => {
  try {
    const userId = req.session.userId;
    if (!userId) {
      throw new UnauthorizedError();
    }

    const body = createCampaignSchema.parse(req.body);
    const result = await createCampaign({ userId, ...body });

    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
};

const listCampaignsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(50),
});

export const listCampaigns: RequestHandler = async (req, res, next) => {
  try {
    const userId = req.session.userId;
    if (!userId) {
      throw new UnauthorizedError();
    }

    const query = listCampaignsQuerySchema.parse(req.query);
    const result = await listCampaignsForUser({ userId, ...query });
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
};
