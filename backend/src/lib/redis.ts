import { createClient } from "redis";
import { Redis } from "ioredis";
import { env } from "../config/env.js";

// node-redis client: used for the express-session store (connect-redis requires
// the `redis` package specifically, not ioredis).
export const redisClient = createClient({
  socket: {
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
  },
});

redisClient.on("error", (err) => {
  console.error("Redis client error:", err);
});

// ioredis client: BullMQ requires ioredis specifically (it doesn't support
// node-redis). Shared across the queue module now and the worker(s) added in
// a later stage — BullMQ instances are meant to reuse one connection, not
// open a new one per Queue/Worker.
export const ioredisConnection = new Redis({
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
  // Required by BullMQ for its blocking commands (used by future workers).
  maxRetriesPerRequest: null,
  // Fail fast instead of buffering commands in memory while Redis is down —
  // queue provisioning needs to know immediately if Redis is unreachable
  // rather than hang, so the failure can be surfaced instead of silently
  // "succeeding" once the connection eventually recovers.
  enableOfflineQueue: false,
  // BullMQ's Queue (see email.queue.ts) manages connecting this itself once
  // constructed and waits for readiness before running commands — don't call
  // .connect() on this elsewhere, it races BullMQ's own connect and throws
  // "Redis is already connecting/connected".
  lazyConnect: true,
});

ioredisConnection.on("error", (err) => {
  console.error("ioredis (BullMQ) connection error:", err);
});

// Custom atomic command backing distributed per-sender rate limiting (see
// services/rate-limit.service.ts). Registered here, next to the connection,
// so it behaves like any other Redis command from the caller's perspective —
// callers never see the Lua script.
//
// KEYS[1] = sender:{id}:last-send      KEYS[2] = sender:{id}:hour:{window}
// ARGV[1] = now (ms)                   ARGV[2] = required delay (ms)
// ARGV[3] = hourly limit               ARGV[4] = hour-key TTL (seconds)
// ARGV[5] = last-send-key TTL (seconds)
//
// Returns [allowed(0|1), reason, meta]:
//   allowed=1              -> reason="allowed",       meta=now
//   blocked by min delay    -> reason="minimum_delay", meta=lastSend+delay (ms)
//   blocked by hourly quota -> reason="hourly_limit",  meta=0 (caller computes next hour)
const RESERVE_SEND_SLOT_LUA = `
local lastSend = tonumber(redis.call('GET', KEYS[1]))
local now = tonumber(ARGV[1])
local delayMs = tonumber(ARGV[2])
local hourlyLimit = tonumber(ARGV[3])
local hourTtl = tonumber(ARGV[4])
local lastSendTtl = tonumber(ARGV[5])

if lastSend and (now - lastSend) < delayMs then
  return {0, "minimum_delay", lastSend + delayMs}
end

local count = tonumber(redis.call('GET', KEYS[2])) or 0
if count >= hourlyLimit then
  return {0, "hourly_limit", 0}
end

redis.call('SET', KEYS[1], tostring(now), 'EX', lastSendTtl)
local newCount = redis.call('INCR', KEYS[2])
if newCount == 1 then
  redis.call('EXPIRE', KEYS[2], hourTtl)
end

return {1, "allowed", now}
`;

ioredisConnection.defineCommand("reserveSendSlot", {
  numberOfKeys: 2,
  lua: RESERVE_SEND_SLOT_LUA,
});

declare module "ioredis" {
  interface RedisCommander<Context> {
    reserveSendSlot(
      lastSendKey: string,
      hourCounterKey: string,
      nowMs: number,
      delayMs: number,
      hourlyLimit: number,
      hourKeyTtlSeconds: number,
      lastSendKeyTtlSeconds: number,
    ): Promise<[allowed: number, reason: string, meta: number]>;
  }
}
