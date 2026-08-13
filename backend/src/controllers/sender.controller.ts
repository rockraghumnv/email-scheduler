import type { RequestHandler } from "express";
import { listSendersForUser } from "../services/sender.service.js";
import { UnauthorizedError } from "../utils/errors.js";

export const listSenders: RequestHandler = async (req, res, next) => {
  try {
    const userId = req.session.userId;
    if (!userId) {
      throw new UnauthorizedError();
    }
    const senders = await listSendersForUser(userId);
    res.status(200).json({ senders });
  } catch (err) {
    next(err);
  }
};
