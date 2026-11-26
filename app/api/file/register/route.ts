import { NextRequest, NextResponse } from "next/server";
import { randomBytes, randomInt } from "crypto";
import { head } from "@vercel/blob";
import { clientIp, createLimit, redis } from "@/lib/redis";
import { FILE_MAX, FILE_TTL, safeName } from "@/lib/fileconfig";
import { EXPIRY_SET, blobToken, fKey, sweepExpired, type FileMeta } from "@/lib/files";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const limited = await createLimit.limit(`filereg:${clientIp(req)}`);
    if (!limited.success) {
      return NextResponse.json({ error: "Too many requests. Try again later." }, { status: 429 });
    }

    const { url } = await req.json().catch(() => ({ url: undefined }));
    let parsed: URL;
    try {
      parsed = new URL(String(url));
    } catch {
      return NextResponse.json({ error: "Invalid file." }, { status: 400 });
    }
    if (parsed.protocol !== "https:" || !parsed.hostname.endsWith(".blob.vercel-storage.com")) {
      return NextResponse.json({ error: "Invalid file." }, { status: 400 });
    }

    const blob = await head(parsed.toString(), { token: blobToken() });
    if (!blob.pathname.startsWith("files/") || blob.size > FILE_MAX) {
      return NextResponse.json({ error: "Invalid file." }, { status: 400 });
    }

    const name = safeName(blob.pathname.split("/").pop() ?? "file");
    const expiresAt = Date.now() + FILE_TTL * 1000;
    const delToken = randomBytes(16).toString("hex");
    const meta: FileMeta = {
      url: blob.url,
      downloadUrl: blob.downloadUrl,
      name,
      size: blob.size,
      expiresAt,
      delToken,
    };

    for (let i = 0; i < 10; i++) {
      const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      const ok = await redis.set(fKey(code), meta, { nx: true, ex: FILE_TTL });
      if (ok) {
        await redis.zadd(EXPIRY_SET, { score: expiresAt, member: blob.url });
        await sweepExpired();
        return NextResponse.json({ code, name, size: blob.size, expiresAt, delToken });
      }
    }
    return NextResponse.json({ error: "Could not allocate a code. Try again." }, { status: 503 });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: "Server error." }, { status: 500 });
  }
}
