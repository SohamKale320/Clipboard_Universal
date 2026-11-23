import { NextRequest, NextResponse } from "next/server";
import { clientIp, liveReadLimit, liveWriteLimit, redis } from "@/lib/redis";
import { LIVE_MAX, LIVE_TTL, tKey, vKey } from "@/lib/live";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

// Poll: cheap when nothing changed (one tiny read of the version counter).
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  try {
    const { code } = await params;
    if (!/^\d{6}$/.test(code)) {
      return NextResponse.json({ error: "Codes are 6 digits." }, { status: 400 });
    }
    const limited = await liveReadLimit.limit(clientIp(req));
    if (!limited.success) {
      return NextResponse.json({ error: "Too many requests." }, { status: 429 });
    }

    const since = Number(new URL(req.url).searchParams.get("v") ?? -1);
    const v = await redis.get<number>(vKey(code));
    if (v === null || v === undefined) {
      return NextResponse.json(
        { error: "Room not found. It may have expired." },
        { status: 404, headers: NO_STORE }
      );
    }
    if (v === since) {
      return NextResponse.json({ v, changed: false }, { headers: NO_STORE });
    }
    const doc = await redis.get<{ t: string }>(tKey(code));
    return NextResponse.json(
      { v, changed: true, text: doc?.t ?? "" },
      { headers: NO_STORE }
    );
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: "Server error." }, { status: 500 });
  }
}

// Write: last write wins.
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  try {
    const { code } = await params;
    if (!/^\d{6}$/.test(code)) {
      return NextResponse.json({ error: "Codes are 6 digits." }, { status: 400 });
    }
    const limited = await liveWriteLimit.limit(clientIp(req));
    if (!limited.success) {
      return NextResponse.json({ error: "Too many edits. Slow down." }, { status: 429 });
    }

    const { text } = await req.json().catch(() => ({ text: undefined }));
    if (typeof text !== "string") {
      return NextResponse.json({ error: "Invalid text." }, { status: 400 });
    }
    if (text.length > LIVE_MAX) {
      return NextResponse.json(
        { error: `Too long (max ${LIVE_MAX.toLocaleString()} characters).` },
        { status: 400 }
      );
    }

    const exists = await redis.exists(vKey(code));
    if (!exists) {
      return NextResponse.json({ error: "Room not found. It may have expired." }, { status: 404 });
    }

    // Text first, then bump the version, so a poll never sees a new version with old text.
    const res = await redis
      .multi()
      .set(tKey(code), { t: text }, { ex: LIVE_TTL })
      .incr(vKey(code))
      .expire(vKey(code), LIVE_TTL)
      .exec<[string, number, number]>();

    return NextResponse.json({ v: res[1] }, { headers: NO_STORE });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: "Server error." }, { status: 500 });
  }
}

// Delete the room for everyone.
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ code: string }> }
) {
  try {
    const { code } = await params;
    if (!/^\d{6}$/.test(code)) {
      return NextResponse.json({ error: "Codes are 6 digits." }, { status: 400 });
    }
    const limited = await liveWriteLimit.limit(clientIp(req));
    if (!limited.success) {
      return NextResponse.json({ error: "Too many requests." }, { status: 429 });
    }
    await redis.del(vKey(code), tKey(code));
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: "Server error." }, { status: 500 });
  }
}
