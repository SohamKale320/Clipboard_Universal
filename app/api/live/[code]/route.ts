import { NextRequest, NextResponse } from "next/server";
import { clientIp, liveMissLimit, liveWriteLimit, redis } from "@/lib/redis";
import { LIVE_MAX, LIVE_TTL, tKey, vKey } from "@/lib/live";
import { publishLive } from "@/lib/pusher";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

const SAVE_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return -1 end
redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[2])
redis.call('EXPIRE', KEYS[1], ARGV[2])
return redis.call('INCR', KEYS[1])
`;

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
    const since = Number(new URL(req.url).searchParams.get("v") ?? -1);
    const v = await redis.get<number>(vKey(code));
    if (v === null || v === undefined) {
      const missed = await liveMissLimit.limit(clientIp(req));
      if (!missed.success) {
        return NextResponse.json({ error: "Too many requests." }, { status: 429 });
      }
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

    const { text, from } = await req.json().catch(() => ({ text: undefined, from: undefined }));
    if (typeof text !== "string") {
      return NextResponse.json({ error: "Invalid text." }, { status: 400 });
    }
    if (text.length > LIVE_MAX) {
      return NextResponse.json(
        { error: `Too long (max ${LIVE_MAX.toLocaleString()} characters).` },
        { status: 400 }
      );
    }

    // One atomic step: only writes if the room still exists, so a save that arrives just after
    // a delete can never bring the room back. Text first, then the version bump.
    const v = (await redis.eval(
      SAVE_SCRIPT,
      [vKey(code), tKey(code)],
      [JSON.stringify({ t: text }), String(LIVE_TTL)]
    )) as number;
    if (v === -1) {
      return NextResponse.json({ error: "Room not found. It may have expired." }, { status: 404 });
    }
    await publishLive(code, "update", {
      v,
      from: typeof from === "string" ? from.slice(0, 64) : "",
      text,
    });
    return NextResponse.json({ v }, { headers: NO_STORE });
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
    await publishLive(code, "deleted", {});
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: "Server error." }, { status: 500 });
  }
}
