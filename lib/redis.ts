import { Redis } from "@upstash/redis";
import { Ratelimit } from "@upstash/ratelimit";
import { MONTHLY_UPLOADS } from "./fileconfig";

const url =
  process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL ?? "";
const token =
  process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN ?? "";

export const redis = new Redis({ url, token });

export const createLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(20, "1 h"),
  prefix: "rl:create",
});

export const readLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(30, "1 m"),
  prefix: "rl:read",
});

// Live rooms are polled about once a second, so these limits are much looser.
export const liveReadLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.fixedWindow(600, "1 m"),
  prefix: "rl:liveread",
});

export const liveWriteLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.fixedWindow(600, "1 m"),
  prefix: "rl:livewrite",
});

// File uploads: per-IP, plus a site-wide monthly cap so the free Blob quota can't be burned.
export const fileLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(10, "1 h"),
  prefix: "rl:file",
});

export const fileGlobalLimit = new Ratelimit({
  redis,
  limiter: Ratelimit.fixedWindow(MONTHLY_UPLOADS, "30 d"),
  prefix: "rl:fileglobal",
});

export function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
}
