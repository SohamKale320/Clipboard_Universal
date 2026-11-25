import { del } from "@vercel/blob";
import { redis } from "@/lib/redis";

export type FileMeta = {
  url: string;
  downloadUrl: string;
  name: string;
  size: number;
  expiresAt: number; // epoch ms
  delToken: string;
};

export const fKey = (code: string) => `file:${code}`;
export const EXPIRY_SET = "files:expiry";

// Delete blobs whose 15 minutes are up. Called on file activity; failures are ignored
// because Blob's own ttlDays is the backstop.
export async function sweepExpired(limit = 20): Promise<number> {
  try {
    const urls = await redis.zrange<string[]>(EXPIRY_SET, 0, Date.now(), {
      byScore: true,
      offset: 0,
      count: limit,
    });
    if (!urls || urls.length === 0) return 0;
    await del(urls);
    await redis.zrem(EXPIRY_SET, ...urls);
    return urls.length;
  } catch (e) {
    console.error("sweep failed", e);
    return 0;
  }
}
