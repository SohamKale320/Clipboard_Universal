import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { del } from "@vercel/blob";
import { clientIp, readLimit, redis } from "@/lib/redis";
import { EXPIRY_SET, fKey, sweepExpired, type FileMeta } from "@/lib/files";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  try {
    const { code } = await params;
    if (!/^\d{6}$/.test(code)) {
      return NextResponse.json({ error: "Codes are 6 digits." }, { status: 400 });
    }
    const limited = await readLimit.limit(clientIp(req));
    if (!limited.success) {
      return NextResponse.json({ error: "Too many attempts. Wait a minute." }, { status: 429 });
    }

    await sweepExpired();

    const meta = await redis.get<FileMeta>(fKey(code));
    if (!meta || meta.expiresAt <= Date.now()) {
      return NextResponse.json(
        { error: "No file with that code. It may have expired or been deleted." },
        { status: 404, headers: NO_STORE }
      );
    }
    return NextResponse.json(
      { name: meta.name, size: meta.size, downloadUrl: meta.downloadUrl, expiresAt: meta.expiresAt },
      { headers: NO_STORE }
    );
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: "Server error." }, { status: 500 });
  }
}

// Sender deletes early with the token returned at upload time.
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  try {
    const { code } = await params;
    if (!/^\d{6}$/.test(code)) {
      return NextResponse.json({ error: "Codes are 6 digits." }, { status: 400 });
    }
    const limited = await readLimit.limit(clientIp(req));
    if (!limited.success) {
      return NextResponse.json({ error: "Too many attempts. Wait a minute." }, { status: 429 });
    }

    const { delToken } = await req.json().catch(() => ({ delToken: undefined }));
    const meta = await redis.get<FileMeta>(fKey(code));
    if (!meta) return NextResponse.json({ ok: true }); // already gone

    const a = Buffer.from(String(delToken ?? ""));
    const b = Buffer.from(meta.delToken);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return NextResponse.json({ error: "Not allowed." }, { status: 403 });
    }

    await del(meta.url);
    await redis.del(fKey(code));
    await redis.zrem(EXPIRY_SET, meta.url);
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: "Server error." }, { status: 500 });
  }
}
