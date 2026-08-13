import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { redisClient } from "./lib/redis.js";

async function main() {
  await redisClient.connect();

  const app = createApp();

  app.listen(env.PORT, () => {
    console.log(`Backend listening on http://localhost:${env.PORT}`);
  });
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
