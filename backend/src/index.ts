import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { redisClient } from "./lib/redis.js";

async function main() {
  await redisClient.connect();
  // ioredisConnection (BullMQ) is intentionally not connected here: BullMQ's
  // Queue manages a lazyConnect connection's lifecycle itself once
  // constructed (see src/queue/email.queue.ts), and calling .connect() on it
  // ourselves races that and throws "already connecting/connected".

  const app = createApp();

  app.listen(env.PORT, () => {
    console.log(`Backend listening on http://localhost:${env.PORT}`);
  });
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
