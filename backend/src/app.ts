import { RedisStore } from "connect-redis";
import cors from "cors";
import express, { type ErrorRequestHandler } from "express";
import session from "express-session";
import { ZodError } from "zod";
import { env } from "./config/env.js";
import { redisClient } from "./lib/redis.js";
import { authRouter } from "./routes/auth.routes.js";
import { campaignRouter } from "./routes/campaign.routes.js";
import { emailRouter } from "./routes/email.routes.js";
import { senderRouter } from "./routes/sender.routes.js";
import { HttpError } from "./utils/errors.js";

export function createApp() {
  const app = express();

  if (env.NODE_ENV === "production") {
    app.set("trust proxy", 1);
  }

  app.use(express.json());
  app.use(
    cors({
      origin: env.FRONTEND_URL,
      credentials: true,
    }),
  );

  app.use(
    session({
      name: "sid",
      store: new RedisStore({ client: redisClient, prefix: "email-scheduler:sess:" }),
      secret: env.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        secure: env.NODE_ENV === "production",
        sameSite: env.NODE_ENV === "production" ? "none" : "lax",
        maxAge: 7 * 24 * 60 * 60 * 1000,
      },
    }),
  );

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.use("/api/auth", authRouter);
  app.use("/api/senders", senderRouter);
  app.use("/api/campaigns", campaignRouter);
  app.use("/api/emails", emailRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof HttpError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    if (err instanceof ZodError) {
      res.status(400).json({ error: "Invalid request", details: err.flatten() });
      return;
    }
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  };

  app.use(errorHandler);

  return app;
}
