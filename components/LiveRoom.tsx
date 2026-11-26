"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import PusherClient, { type PresenceChannel } from "pusher-js";

type Status = "connecting" | "live" | "offline" | "gone";

// Every version of the text carries a stamp: a logical clock plus the writer's id as tie-breaker.
// The highest stamp wins everywhere (socket messages, saved copy, polling), so devices converge
// no matter what order messages arrive in.
type Stamp = { rev: number; from: string };
const newer = (a: Stamp, b: Stamp) => a.rev > b.rev || (a.rev === b.rev && a.from > b.from);

const SEND_EVERY = 110; // ms between live-socket messages while typing (Pusher allows 10 per second)
const MAX_SOCKET_BYTES = 7000; // Pusher events are limited to 10 KB; bigger text uses the saved copy
const SAVE_DELAY_REALTIME = 500; // saved copy only needs to keep up loosely when the socket is live
const SAVE_DELAY_POLLING = 120;
const FAST_POLL = 400; // polling is the fallback when the live socket isn't connected
const SLOW_POLL = 1500;
const SAFETY_POLL = 8000; // backstop while the socket is connected
const QUIET_AFTER = 15000;
const POLL_TIMEOUT = 4000;
const SAVE_TIMEOUT = 6000;
const TYPING_IDLE = 400; // don't replace the box while you are actively typing

const PUSHER_KEY = process.env.NEXT_PUBLIC_PUSHER_KEY;
const PUSHER_CLUSTER = process.env.NEXT_PUBLIC_PUSHER_CLUSTER;

// A request that can never hang: cancelled after `ms` so one stalled connection can't freeze syncing.
async function timedJson(url: string, init: RequestInit, ms: number) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(url, { ...init, signal: ac.signal });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok, data };
  } finally {
    clearTimeout(timer);
  }
}

function randomId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export default function LiveRoom({ code }: { code: string }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [status, setStatus] = useState<Status>("connecting");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const [showQr, setShowQr] = useState(false);
  const [qr, setQr] = useState("");
  const [staleSecs, setStaleSecs] = useState(0);
  const [peers, setPeers] = useState<number | null>(null);
  const [instant, setInstant] = useState(false); // live socket connected

  const taRef = useRef<HTMLTextAreaElement>(null);
  const clientId = useRef(randomId());
  const textRef = useRef("");
  const stampRef = useRef<Stamp>({ rev: -1, from: "" }); // stamp of the text on screen
  const seenRevRef = useRef(-1); // highest clock value seen from anyone
  const versionRef = useRef(-1); // saved-copy version, for cheap "anything new?" polls
  const dirtyRef = useRef(false); // local edits not yet saved
  const pendingRef = useRef<{ text: string; stamp: Stamp } | null>(null); // remote text waiting for you to stop typing
  const pendingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTypedRef = useRef(0);
  const lastActivityRef = useRef(Date.now());
  const lastOkRef = useRef(Date.now());
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);
  const saveRef = useRef<() => void>(() => {});
  const channelRef = useRef<PresenceChannel | null>(null);
  const connectedRef = useRef(false);
  const sendTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSendRef = useRef(0);
  const fetchRef = useRef<() => Promise<"ok" | "gone" | "limited" | "error">>(async () => "ok");
  const considerRef = useRef<(remote: string, stamp: Stamp) => void>(() => {});

  function setConnected(on: boolean) {
    connectedRef.current = on;
    setInstant(on);
  }

  // ---------- saving the backup copy ----------
  function scheduleSave(delay: number) {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      saveRef.current();
    }, delay);
  }
  const saveDelay = () => (connectedRef.current ? SAVE_DELAY_REALTIME : SAVE_DELAY_POLLING);

  saveRef.current = async () => {
    if (savingRef.current) {
      scheduleSave(100);
      return;
    }
    const snapshot = textRef.current;
    const stamp = stampRef.current;
    savingRef.current = true;
    try {
      const { status: st, ok, data } = await timedJson(
        `/api/live/${code}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: snapshot, from: clientId.current, rev: stamp.rev }),
        },
        SAVE_TIMEOUT
      );
      if (ok) {
        if (data.applied) versionRef.current = data.v;
        lastOkRef.current = Date.now();
        setStatus("live");
        setError("");
        if (textRef.current === snapshot) dirtyRef.current = false;
        else scheduleSave(saveDelay()); // typed more while saving
      } else if (st === 404) {
        setStatus("gone");
      } else {
        setError(data.error || "Could not save your last change.");
        scheduleSave(1000);
      }
    } catch {
      setStatus("offline");
      scheduleSave(1000);
    } finally {
      savingRef.current = false;
    }
  };

  // ---------- sending live over the socket ----------
  function broadcastNow() {
    const ch = channelRef.current;
    if (!ch || !connectedRef.current) return;
    if (stampRef.current.from !== clientId.current) return; // only send text that is mine
    const payload = { from: clientId.current, rev: stampRef.current.rev, text: textRef.current };
    if (JSON.stringify(payload).length > MAX_SOCKET_BYTES) return; // too big, saved copy carries it
    lastSendRef.current = Date.now();
    try {
      ch.trigger("client-text", payload);
    } catch {
      /* the saved copy and polling still cover it */
    }
  }

  function queueBroadcast() {
    if (sendTimer.current) return;
    const wait = Math.max(0, SEND_EVERY - (Date.now() - lastSendRef.current));
    sendTimer.current = setTimeout(() => {
      sendTimer.current = null;
      broadcastNow();
    }, wait);
  }

  // ---------- receiving ----------
  function applyNow(remote: string, stamp: Stamp) {
    const ta = taRef.current;
    const start = ta?.selectionStart ?? 0;
    const end = ta?.selectionEnd ?? 0;
    textRef.current = remote;
    stampRef.current = stamp;
    dirtyRef.current = false; // anything unsaved of mine was older, so it is superseded
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    setText(remote);
    requestAnimationFrame(() => {
      if (ta && document.activeElement === ta) {
        ta.setSelectionRange(Math.min(start, remote.length), Math.min(end, remote.length));
      }
    });
  }

  function flushPending() {
    pendingTimer.current = null;
    const p = pendingRef.current;
    if (!p) return;
    if (!newer(p.stamp, stampRef.current)) {
      pendingRef.current = null; // my own newer edit won
      return;
    }
    if (Date.now() - lastTypedRef.current > TYPING_IDLE) {
      pendingRef.current = null;
      applyNow(p.text, p.stamp);
    } else {
      pendingTimer.current = setTimeout(flushPending, TYPING_IDLE);
    }
  }

  function consider(remote: string, stamp: Stamp) {
    seenRevRef.current = Math.max(seenRevRef.current, stamp.rev);
    if (!newer(stamp, stampRef.current)) return; // not newer than what is on screen
    if (Date.now() - lastTypedRef.current > TYPING_IDLE) {
      pendingRef.current = null;
      applyNow(remote, stamp);
    } else {
      if (!pendingRef.current || newer(stamp, pendingRef.current.stamp)) {
        pendingRef.current = { text: remote, stamp };
      }
      if (!pendingTimer.current) pendingTimer.current = setTimeout(flushPending, TYPING_IDLE);
    }
  }

  async function fetchAndApply(): Promise<"ok" | "gone" | "limited" | "error"> {
    try {
      const { status: st, ok, data } = await timedJson(
        `/api/live/${code}?v=${versionRef.current}`,
        { cache: "no-store" },
        POLL_TIMEOUT
      );
      if (st === 404) {
        setStatus("gone");
        return "gone";
      }
      if (st === 429) return "limited";
      if (!ok) return "error";
      lastOkRef.current = Date.now();
      setStatus("live");
      if (data.changed) {
        lastActivityRef.current = Date.now();
        consider(data.text, { rev: data.rev ?? 0, from: data.from ?? "" });
        versionRef.current = data.v;
      }
      return "ok";
    } catch {
      setStatus("offline");
      return "error";
    }
  }

  // Effects run once, so they reach the latest functions through refs.
  fetchRef.current = fetchAndApply;
  considerRef.current = consider;

  // ---------- polling: the fallback, and a slow backstop while the socket is up ----------
  useEffect(() => {
    let stopped = false;
    let running = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      if (stopped || running) return;
      if (document.hidden) {
        timer = setTimeout(poll, 2000);
        return;
      }
      running = true;
      const result = await fetchRef.current();
      running = false;
      if (stopped || result === "gone") return;

      let delay: number;
      if (result === "limited") delay = 2000;
      else if (result === "error") delay = 1000;
      else if (connectedRef.current) delay = SAFETY_POLL;
      else {
        const quiet = Date.now() - Math.max(lastActivityRef.current, lastTypedRef.current) > QUIET_AFTER;
        delay = quiet ? SLOW_POLL : FAST_POLL;
      }
      timer = setTimeout(poll, delay);
    }

    poll();

    const wake = () => {
      if (!document.hidden && !running) {
        if (timer) clearTimeout(timer);
        poll();
      }
    };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    window.addEventListener("pageshow", wake);

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (sendTimer.current) clearTimeout(sendTimer.current);
      if (pendingTimer.current) clearTimeout(pendingTimer.current);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
      window.removeEventListener("pageshow", wake);
    };
  }, [code]);

  // Show it when syncing stalls, instead of letting it just feel laggy
  useEffect(() => {
    const id = setInterval(() => {
      if (document.hidden) return;
      const age = Date.now() - lastOkRef.current;
      const limit = connectedRef.current ? 20000 : 4000;
      setStaleSecs(age > limit ? Math.floor(age / 1000) : 0);
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // ---------- the live socket ----------
  useEffect(() => {
    if (!PUSHER_KEY || !PUSHER_CLUSTER) return;
    const pusher = new PusherClient(PUSHER_KEY, {
      cluster: PUSHER_CLUSTER,
      channelAuthorization: { endpoint: "/api/pusher/auth", transport: "ajax" },
    });
    const name = `presence-live-${code}`;
    const channel = pusher.subscribe(name) as PresenceChannel;
    channelRef.current = channel;

    pusher.connection.bind("state_change", (s: { current: string }) => {
      setConnected(s.current === "connected" && channel.subscribed);
    });
    channel.bind("pusher:subscription_succeeded", () => {
      setConnected(true);
      setPeers(channel.members.count);
      void fetchRef.current(); // get the saved copy so a late joiner starts in sync
    });
    channel.bind("pusher:member_added", () => {
      setPeers(channel.members.count);
      // someone just joined: show them what we have right away
      if (dirtyRef.current || stampRef.current.from === clientId.current) broadcastNow();
    });
    channel.bind("pusher:member_removed", () => setPeers(channel.members.count));

    // the fast path: the other device's text, straight through the socket
    channel.bind("client-text", (d: { from?: string; rev?: number; text?: string }) => {
      if (typeof d?.text !== "string" || typeof d.rev !== "number" || typeof d.from !== "string") return;
      if (d.from === clientId.current) return;
      lastActivityRef.current = Date.now();
      lastOkRef.current = Date.now();
      considerRef.current(d.text, { rev: d.rev, from: d.from });
    });

    // a save somewhere: only fetch it if it is newer than what we show (large text, or sockets off)
    channel.bind("update", (d: { from?: string; rev?: number }) => {
      if (d?.from === clientId.current) return;
      if (typeof d?.rev === "number" && typeof d.from === "string") {
        seenRevRef.current = Math.max(seenRevRef.current, d.rev);
        if (!newer({ rev: d.rev, from: d.from }, stampRef.current)) return;
      }
      void fetchRef.current();
    });
    channel.bind("deleted", () => setStatus("gone"));

    return () => {
      channelRef.current = null;
      setConnected(false);
      setPeers(null);
      channel.unbind_all();
      pusher.unsubscribe(name);
      pusher.disconnect();
    };
  }, [code]);

  // ---------- QR ----------
  useEffect(() => {
    if (!showQr) return;
    const url = `${window.location.origin}/live/${code}`;
    QRCode.toDataURL(url, { margin: 1, width: 220 }).then(setQr).catch(() => setQr(""));
  }, [showQr, code]);

  // ---------- local edits ----------
  function localEdit(next: string) {
    textRef.current = next;
    setText(next);
    // my edit is newer than everything I have seen, so it wins over buffered remote text
    stampRef.current = {
      rev: Math.max(stampRef.current.rev, seenRevRef.current, 0) + 1,
      from: clientId.current,
    };
    seenRevRef.current = stampRef.current.rev;
    dirtyRef.current = true;
    lastTypedRef.current = Date.now();
    lastActivityRef.current = Date.now();
    queueBroadcast();
    if (!saveTimer.current) scheduleSave(saveDelay());
  }

  function onChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    localEdit(e.target.value);
  }

  function clearAll() {
    localEdit("");
  }

  async function leaveRoom() {
    // Save any unsent edit first so it isn't lost, then go back to the start page.
    if (saveTimer.current) clearTimeout(saveTimer.current);
    if (dirtyRef.current) {
      try {
        await fetch(`/api/live/${code}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: textRef.current,
            from: clientId.current,
            rev: stampRef.current.rev,
          }),
          keepalive: true,
        });
      } catch {
        /* leaving anyway */
      }
    }
    router.push("/live");
  }

  async function deleteRoom() {
    if (!window.confirm("Delete this room for everyone? The text will be gone for all devices.")) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    try {
      const res = await fetch(`/api/live/${code}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "Could not delete the room.");
        return;
      }
    } catch {
      setError("Could not reach the server. Try again.");
      return;
    }
    router.push("/live");
  }

  async function copy(what: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(what);
      setTimeout(() => setCopied(""), 1500);
    } catch {
      setError("Copy failed. Select the text and copy it manually.");
    }
  }

  if (status === "gone") {
    return (
      <main className="shell">
        <header className="hero">
          <h1>
            <span className="l1">Room</span>
            <span className="l2">not found</span>
          </h1>
          <p className="tag">
            Room {code} doesn&apos;t exist, or it expired after 24 hours without edits.
          </p>
        </header>
        <section className="panel">
          <Link href="/live" className="primary" style={{ textAlign: "center", textDecoration: "none" }}>
            Start a new room
          </Link>
        </section>
      </main>
    );
  }

  const statusText =
    status === "offline" ? "Offline, retrying" : status === "connecting" ? "Connecting…" : instant ? "Live, instant" : "Live, synced";

  return (
    <main className="shell">
      <header className="hero">
        <h1 aria-label={`Live room ${code.split("").join(" ")}`}>
          <span className="l1 mono">
            {code.slice(0, 3)} {code.slice(3)}
          </span>
          <span className="l2">live room</span>
        </h1>
      </header>

      <section className="panel">
        <div className="statusbar">
          <span className={`dot ${status === "live" ? "live" : status === "offline" ? "offline" : ""}`} />
          <span>{statusText}</span>
          {staleSecs > 0 && (
            <span style={{ color: "var(--err)" }}>· last synced {staleSecs}s ago, retrying</span>
          )}
          {peers !== null && (
            <span>· {peers <= 1 ? "just you here" : `${peers} devices connected`}</span>
          )}
          <span className="spacer" />
          <span>{text.length.toLocaleString()} characters</span>
        </div>

        <textarea
          ref={taRef}
          className="livetext"
          value={text}
          onChange={onChange}
          placeholder="Type or paste here. It appears on every device in this room."
          maxLength={200000}
          spellCheck={false}
          autoFocus
        />

        {error && <p className="err">{error}</p>}

        <div className="row">
          <button className="primary" onClick={() => copy("text", text)} disabled={!text}>
            {copied === "text" ? "Copied" : "Copy text"}
          </button>
          <button
            className="secondary"
            onClick={() => copy("link", `${window.location.origin}/live/${code}`)}
          >
            {copied === "link" ? "Copied" : "Copy room link"}
          </button>
        </div>
        <div className="row">
          <button className="secondary" onClick={() => setShowQr((s) => !s)}>
            {showQr ? "Hide QR code" : "Show QR code"}
          </button>
          <button className="secondary" onClick={clearAll} disabled={!text}>
            Clear text
          </button>
        </div>

        <div className="row">
          <button className="secondary" onClick={leaveRoom}>
            Leave room
          </button>
          <button className="secondary danger" onClick={deleteRoom}>
            Delete room
          </button>
        </div>

        {showQr && qr && (
          <div className="qr">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qr} alt="QR code linking to this room" width={220} height={220} />
            <p className="meta">Scan to join this room on your phone.</p>
          </div>
        )}
      </section>
    </main>
  );
}
