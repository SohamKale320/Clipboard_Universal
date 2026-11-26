import Pusher from "pusher";
import { randomUUID } from "crypto";

let client: Pusher | null | undefined;

// Real-time is optional. With these 4 variables missing, the app falls back to polling.
//   NEXT_PUBLIC_PUSHER_KEY, NEXT_PUBLIC_PUSHER_CLUSTER  (public, also used by the browser)
//   PUSHER_APP_ID, PUSHER_SECRET                        (server only, never expose)
function pusherServer(): Pusher | null {
  if (client !== undefined) return client;
  const key = process.env.NEXT_PUBLIC_PUSHER_KEY;
  const cluster = process.env.NEXT_PUBLIC_PUSHER_CLUSTER;
  const appId = process.env.PUSHER_APP_ID;
  const secret = process.env.PUSHER_SECRET;
  client = key && cluster && appId && secret ? new Pusher({ appId, key, secret, cluster, useTLS: true }) : null;
  return client;
}

// Pusher allows 10 KB per event, so big text is sent as a signal and fetched by the receiver.
const MAX_EVENT_BYTES = 8000;

export async function publishLive(
  code: string,
  event: "update" | "deleted",
  payload: { v?: number; from?: string; rev?: number; text?: string }
) {
  const p = pusherServer();
  if (!p) return;
  try {
    let data = payload;
    if (Buffer.byteLength(JSON.stringify(data)) > MAX_EVENT_BYTES) {
      data = { v: payload.v, from: payload.from, rev: payload.rev }; // no text: receivers fetch it
    }
    await p.trigger(`presence-live-${code}`, event, data);
  } catch (e) {
    // never fail a save because the push service had a problem; the backstop poll covers it
    console.error("pusher trigger failed", e);
  }
}

// Presence channels need the server to vouch for each connection.
// Every connection gets its own random id, so each open tab counts as one device.
export function authorizePresence(socketId: string, channelName: string) {
  const p = pusherServer();
  if (!p) return null;
  return p.authorizeChannel(socketId, channelName, { user_id: randomUUID() });
}
