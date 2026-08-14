import type { RequestHandler } from "express";
import { z } from "zod";
import { listScheduledEmailsForUser, listSentEmailsForUser } from "../services/email.service.js";
import { UnauthorizedError } from "../utils/errors.js";

const paginationSchema = {
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(50),
};

const listScheduledQuerySchema = z.object({
  ...paginationSchema,
  campaignId: z.string().uuid().optional(),
});

const listSentQuerySchema = z.object({
  ...paginationSchema,
  campaignId: z.string().uuid().optional(),
  status: z.enum(["sent", "failed"]).optional(),
});

export const listScheduledEmails: RequestHandler = async (req, res, next) => {
  try {
    const userId = req.session.userId;
    if (!userId) {
      throw new UnauthorizedError();
    }

    const query = listScheduledQuerySchema.parse(req.query);
    const result = await listScheduledEmailsForUser({ userId, ...query });
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
};

export const listSentEmails: RequestHandler = async (req, res, next) => {
  try {
    const userId = req.session.userId;
    if (!userId) {
      throw new UnauthorizedError();
    }

    const query = listSentQuerySchema.parse(req.query);
    const result = await listSentEmailsForUser({ userId, ...query });
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
};
