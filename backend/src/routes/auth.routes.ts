import { Router } from "express";
import { googleCallback, googleRedirect, login, logout, me, register } from "../controllers/auth.controller.js";
import { requireAuth } from "../middleware/auth.middleware.js";

export const authRouter = Router();

authRouter.post("/register", register);
authRouter.post("/login", login);
authRouter.post("/logout", logout);
authRouter.get("/me", requireAuth, me);

authRouter.get("/google", googleRedirect);
authRouter.get("/google/callback", googleCallback);
