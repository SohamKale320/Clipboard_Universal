import { NextRequest, NextResponse } from "next/server";
import { randomInt } from "crypto";
import { clientIp, createLimit, redis } from "@/lib/redis";
import { LIVE_TTL, tKey, vKey } from "@/lib/live";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const limited = await createLimit.limit(`live:${clientIp(req)}`);
    if (!limited.success) {
      return NextResponse.json(
        { error: "Too many rooms from this network. Try again later." },
        { status: 429 }
      );
    }

    for (let i = 0; i < 10; i++) {
      const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      const ok = await redis.set(vKey(code), 0, { nx: true, ex: LIVE_TTL });
      if (ok) {
        await redis.set(tKey(code), { t: "" }, { ex: LIVE_TTL });
        return NextResponse.json({ code });
      }
    }
    return NextResponse.json({ error: "Could not allocate a room. Try again." }, { status: 503 });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: "Server error." }, { status: 500 });
  }
}
