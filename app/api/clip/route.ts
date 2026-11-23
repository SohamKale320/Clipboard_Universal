import { NextRequest, NextResponse } from "next/server";
import { randomBytes, randomInt, scryptSync } from "crypto";
import { clientIp, createLimit, redis } from "@/lib/redis";

const MAX_LEN = 200_000; // characters
const EXPIRIES: Record<string, number> = {
  "5m": 300,
  "1h": 3600,
  "1d": 86400,
  "1w": 604800,
  "1m": 2592000,
  "1y": 31536000,
};

export async function POST(req: NextRequest) {
  try {
    const limited = await createLimit.limit(clientIp(req));
    if (!limited.success) {
      return NextResponse.json(
        { error: "Too many clips from this network. Try again later." },
        { status: 429 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const { text, expiry = "1d", passcode, burn = false } = body;

    if (typeof text !== "string" || !text.trim()) {
      return NextResponse.json({ error: "Enter some text first." }, { status: 400 });
    }
    if (text.length > MAX_LEN) {
      return NextResponse.json(
        { error: `Text is too long (max ${MAX_LEN.toLocaleString()} characters).` },
        { status: 400 }
      );
    }
    const ttl = EXPIRIES[expiry];
    if (!ttl) {
      return NextResponse.json({ error: "Invalid expiry." }, { status: 400 });
    }

    let salt = "";
    let hash = "";
    if (passcode) {
      salt = randomBytes(16).toString("hex");
      hash = scryptSync(String(passcode), salt, 64).toString("hex");
    }

    const value = JSON.stringify({ text, burn: !!burn, salt, hash });

    for (let i = 0; i < 10; i++) {
      const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      const ok = await redis.set(`clip:${code}`, value, { nx: true, ex: ttl });
      if (ok) return NextResponse.json({ code, ttl });
    }
    return NextResponse.json({ error: "Could not allocate a code. Try again." }, { status: 503 });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: "Server error." }, { status: 500 });
  }
}
