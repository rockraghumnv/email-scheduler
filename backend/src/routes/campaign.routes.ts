import { Router } from "express";
import { createCampaignHandler, listCampaigns } from "../controllers/campaign.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";

export const campaignRouter = Router();

campaignRouter.post("/", requireAuth, createCampaignHandler);
campaignRouter.get("/", requireAuth, listCampaigns);
