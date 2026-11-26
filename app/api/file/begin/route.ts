import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { clientIp, fileGlobalLimit, fileLimit, redis } from "@/lib/redis";
import { FILE_MAX } from "@/lib/fileconfig";
import { blobToken } from "@/lib/files";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    if (!blobToken()) {
      return NextResponse.json(
        { error: "File storage isn't connected yet. Add a Blob store to the Vercel project and redeploy." },
        { status: 503 }
      );
    }
    const { size } = await req.json().catch(() => ({ size: undefined }));
    if (typeof size !== "number" || !(size > 0)) {
      return NextResponse.json({ error: "Pick a file first." }, { status: 400 });
    }
    if (size > FILE_MAX) {
      return NextResponse.json({ error: "Files can be up to 50 MB." }, { status: 400 });
    }

    const per = await fileLimit.limit(clientIp(req));
    if (!per.success) {
      return NextResponse.json(
        { error: "Upload limit reached (10 per hour). Try again later." },
        { status: 429 }
      );
    }
    const global = await fileGlobalLimit.limit("global");
    if (!global.success) {
      return NextResponse.json(
        { error: "This site has reached its monthly upload limit." },
        { status: 429 }
      );
    }

    const ticket = randomBytes(16).toString("hex");
    const folder = randomBytes(12).toString("hex"); // unguessable part of the file's address
    await redis.set(`fileticket:${ticket}`, { folder }, { ex: 600 });
    return NextResponse.json({ ticket, folder });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: "Server error." }, { status: 500 });
  }
}
