import { NextRequest, NextResponse } from "next/server";
import { scryptSync, timingSafeEqual } from "crypto";
import { clientIp, readLimit, redis } from "@/lib/redis";

type Clip = { text: string; burn: boolean; salt: string; hash: string };

const MAX_FAILS = 5;

export async function POST(
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
      return NextResponse.json(
        { error: "Too many attempts. Wait a minute and try again." },
        { status: 429 }
      );
    }

    const key = `clip:${code}`;
    const { passcode } = await req.json().catch(() => ({}));

    const clip = await redis.get<Clip>(key);
    if (!clip) {
      return NextResponse.json(
        { error: "No clip with that code. It may have expired or been read already." },
        { status: 404 }
      );
    }

    if (clip.hash) {
      if (!passcode) {
        return NextResponse.json({ error: "This clip needs a passcode.", locked: true }, { status: 401 });
      }
      const attempt = scryptSync(String(passcode), clip.salt, 64);
      const good = timingSafeEqual(attempt, Buffer.from(clip.hash, "hex"));
      if (!good) {
        const failKey = `fails:${code}`;
        const fails = await redis.incr(failKey);
        await redis.expire(failKey, 3600);
        if (fails >= MAX_FAILS) {
          await redis.del(key, failKey);
          return NextResponse.json(
            { error: "Too many wrong passcodes. The clip was deleted." },
            { status: 410 }
          );
        }
        return NextResponse.json(
          { error: `Wrong passcode. ${MAX_FAILS - fails} tries left.`, locked: true },
          { status: 401 }
        );
      }
    }

    if (clip.burn) {
      // Atomic read+delete so only one reader ever gets it
      const got = await redis.getdel<Clip>(key);
      if (!got) {
        return NextResponse.json({ error: "This clip was already read." }, { status: 404 });
      }
      return NextResponse.json({ text: got.text, burned: true });
    }

    return NextResponse.json({ text: clip.text });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: "Server error." }, { status: 500 });
  }
}
