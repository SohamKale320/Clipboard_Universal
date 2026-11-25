import { NextRequest, NextResponse } from "next/server";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { redis } from "@/lib/redis";
import { FILE_MAX } from "@/lib/fileconfig";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as HandleUploadBody | null;
  if (!body) return NextResponse.json({ error: "Bad request." }, { status: 400 });

  try {
    const json = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        if (typeof clientPayload !== "string" || !/^[a-f0-9]{32}$/.test(clientPayload)) {
          throw new Error("Missing upload ticket.");
        }
        // one-time ticket, issued by /api/file/begin after the rate limits passed
        const t = await redis.getdel<{ folder: string }>(`fileticket:${clientPayload}`);
        if (!t?.folder) throw new Error("Upload ticket expired.");

        const prefix = `files/${t.folder}/`;
        if (
          !pathname.startsWith(prefix) ||
          pathname.slice(prefix.length).includes("/") ||
          pathname.length > 220
        ) {
          throw new Error("Invalid file path.");
        }

        return {
          maximumSizeInBytes: FILE_MAX,
          allowedContentTypes: ["application/octet-stream"], // forces download, never renders in a browser
          addRandomSuffix: false, // the random folder already makes the address unguessable
          allowOverwrite: false,
          ttlDays: 1, // backstop: Blob removes anything we missed within about a day
          validUntil: Date.now() + 30 * 60 * 1000,
        };
      },
    });
    return NextResponse.json(json);
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
