import { Router } from "express";
import { listScheduledEmails, listSentEmails } from "../controllers/email.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";

export const emailRouter = Router();

emailRouter.get("/scheduled", requireAuth, listScheduledEmails);
emailRouter.get("/sent", requireAuth, listSentEmails);
