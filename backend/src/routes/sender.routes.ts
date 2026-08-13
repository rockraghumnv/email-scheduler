import { Router } from "express";
import { listSenders } from "../controllers/sender.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";

export const senderRouter = Router();

senderRouter.get("/", requireAuth, listSenders);
