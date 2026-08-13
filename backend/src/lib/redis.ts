import { createClient } from "redis";
import { env } from "../config/env.js";

// node-redis client: used for the express-session store (connect-redis requires
// the `redis` package specifically, not ioredis). BullMQ's queue connection is
// a separate concern and should use `ioredis` when the queue is implemented.
export const redisClient = createClient({
  socket: {
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
  },
});

redisClient.on("error", (err) => {
  console.error("Redis client error:", err);
});
