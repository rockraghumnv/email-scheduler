import { randomBytes } from "node:crypto";
import type { Request, RequestHandler } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import {
  authenticateWithGoogle,
  authenticateWithPassword,
  getGoogleAuthUrl,
  getUserById,
  registerWithPassword,
} from "../services/auth.service.js";
import { HttpError, UnauthorizedError } from "../utils/errors.js";

function regenerateSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });
}

function saveSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.save((err) => (err ? reject(err) : resolve()));
  });
}

const registerSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  name: z.string().trim().min(1).max(120).optional(),
});

const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
});

export const register: RequestHandler = async (req, res, next) => {
  try {
    const body = registerSchema.parse(req.body);
    const user = await registerWithPassword(body);

    await regenerateSession(req);
    req.session.userId = user.id;
    await saveSession(req);

    res.status(201).json({ user });
  } catch (err) {
    next(err);
  }
};

export const login: RequestHandler = async (req, res, next) => {
  try {
    const body = loginSchema.parse(req.body);
    const user = await authenticateWithPassword(body);

    await regenerateSession(req);
    req.session.userId = user.id;
    await saveSession(req);

    res.status(200).json({ user });
  } catch (err) {
    next(err);
  }
};

export const logout: RequestHandler = (req, res, next) => {
  req.session.destroy((err) => {
    if (err) {
      next(err);
      return;
    }
    res.clearCookie("sid");
    res.status(204).end();
  });
};

export const me: RequestHandler = async (req, res, next) => {
  try {
    const userId = req.session.userId;
    if (!userId) {
      throw new UnauthorizedError();
    }
    const user = await getUserById(userId);
    if (!user) {
      throw new UnauthorizedError();
    }
    res.status(200).json({ user });
  } catch (err) {
    next(err);
  }
};

export const googleRedirect: RequestHandler = (req, res) => {
  const state = randomBytes(16).toString("hex");
  req.session.oauthState = state;
  res.redirect(getGoogleAuthUrl(state));
};

export const googleCallback: RequestHandler = async (req, res, next) => {
  try {
    const code = typeof req.query.code === "string" ? req.query.code : undefined;
    const state = typeof req.query.state === "string" ? req.query.state : undefined;

    if (!code || !state || !req.session.oauthState || state !== req.session.oauthState) {
      throw new HttpError(400, "Invalid Google OAuth state");
    }

    delete req.session.oauthState;

    const user = await authenticateWithGoogle(code);

    await regenerateSession(req);
    req.session.userId = user.id;
    await saveSession(req);

    res.redirect(`${env.FRONTEND_URL}/dashboard`);
  } catch (err) {
    console.error("Google OAuth callback failed:", err);
    res.redirect(`${env.FRONTEND_URL}/login?error=google_auth_failed`);
  }
};
