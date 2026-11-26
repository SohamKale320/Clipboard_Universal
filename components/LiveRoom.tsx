"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import PusherClient, { type PresenceChannel } from "pusher-js";

type Status = "connecting" | "live" | "offline" | "gone";

const SAVE_DELAY = 120; // ms: edits are sent at most this often while typing
const FAST_POLL = 400; // used only when real-time (Pusher) isn't available
const SLOW_POLL = 1500; // when nothing has happened for a while
const POLL_TIMEOUT = 4000; // give up on a stuck request after this and try again
const SAVE_TIMEOUT = 6000;
const SAFETY_POLL = 8000; // when real-time is connected, just a backstop
const QUIET_AFTER = 15000;
const TYPING_IDLE = 400; // don't overwrite the box while you are actively typing

const PUSHER_KEY = process.env.NEXT_PUBLIC_PUSHER_KEY;
const PUSHER_CLUSTER = process.env.NEXT_PUBLIC_PUSHER_CLUSTER;

// A request that can never hang: it is cancelled after `ms`, so one stalled connection
// (very common on phones and Wi-Fi) can't freeze syncing for a minute.
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
  const [peers, setPeers] = useState<number | null>(null); // devices in the room, null = unknown

  const taRef = useRef<HTMLTextAreaElement>(null);
  const textRef = useRef("");
  const versionRef = useRef(-1);
  const dirtyRef = useRef(false);
  const lastTypedRef = useRef(0);
  const lastActivityRef = useRef(Date.now());
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);
  const saveRef = useRef<() => void>(() => {});
  const clientId = useRef(randomId());
  const connectedRef = useRef(false); // true while the real-time connection is up
  const fetchRef = useRef<() => Promise<"ok" | "gone" | "limited" | "error">>(async () => "ok");
  const applyIfIdleRef = useRef<(remote: string, v: number) => void>(() => {});

  function scheduleSave(delay: number) {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      saveRef.current();
    }, delay);
  }

  // Latest save function lives in a ref so retries always call the current one.
  saveRef.current = async () => {
    if (savingRef.current) {
      scheduleSave(100);
      return;
    }
    const snapshot = textRef.current;
    savingRef.current = true;
    try {
      const { status, ok, data } = await timedJson(
        `/api/live/${code}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: snapshot, from: clientId.current }),
        },
        SAVE_TIMEOUT
      );
      if (ok) {
        versionRef.current = data.v;
        setStatus("live");
        setError("");
        if (textRef.current === snapshot) {
          dirtyRef.current = false;
        } else {
          scheduleSave(SAVE_DELAY); // typed more while saving
        }
      } else if (status === 404) {
        setStatus("gone");
      } else {
        setError(data.error || "Could not save your last change.");
        scheduleSave(1000);
      }
    } catch {
      setStatus("offline");
      scheduleSave(1000); // keep dirty, retry quickly
    } finally {
      savingRef.current = false;
    }
  };

  function applyRemote(remote: string, v: number) {
    const ta = taRef.current;
    const start = ta?.selectionStart ?? 0;
    const end = ta?.selectionEnd ?? 0;
    textRef.current = remote;
    versionRef.current = v;
    setText(remote);
    requestAnimationFrame(() => {
      if (ta && document.activeElement === ta) {
        ta.setSelectionRange(Math.min(start, remote.length), Math.min(end, remote.length));
      }
    });
  }

  // Apply a remote change only if it is newer and you are not in the middle of typing.
  function applyIfIdle(remote: string, v: number) {
    if (v <= versionRef.current) return;
    const idle = Date.now() - lastTypedRef.current > TYPING_IDLE;
    if (!dirtyRef.current && idle) applyRemote(remote, v);
  }

  async function fetchAndApply(): Promise<"ok" | "gone" | "limited" | "error"> {
    try {
      const { status, ok, data } = await timedJson(
        `/api/live/${code}?v=${versionRef.current}`,
        { cache: "no-store" },
        POLL_TIMEOUT
      );
      if (status === 404) {
        setStatus("gone");
        return "gone";
      }
      if (status === 429) return "limited";
      if (!ok) return "error";
      setStatus("live");
      if (data.changed) {
        lastActivityRef.current = Date.now();
        applyIfIdle(data.text, data.v);
      }
      return "ok";
    } catch {
      setStatus("offline");
      return "error";
    }
  }

  // Effects run once, so give them the latest versions of these through refs.
  fetchRef.current = fetchAndApply;
  applyIfIdleRef.current = applyIfIdle;

  // Polling loop: fast on its own, a slow backstop when real-time is connected
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
      if (stopped || result === "gone") return; // room is gone, stop polling

      let delay: number;
      if (result === "limited") delay = 2000;
      else if (result === "error") delay = 1000;
      else if (connectedRef.current) delay = SAFETY_POLL;
      else {
        const quiet =
          Date.now() - Math.max(lastActivityRef.current, lastTypedRef.current) > QUIET_AFTER;
        delay = quiet ? SLOW_POLL : FAST_POLL;
      }
      timer = setTimeout(poll, delay);
    }

    poll();

    const onVisible = () => {
      if (!document.hidden && !running) {
        if (timer) clearTimeout(timer);
        poll();
      }
    };
    const wake = () => {
      if (!document.hidden && !running) {
        if (timer) clearTimeout(timer);
        poll();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    window.addEventListener("pageshow", wake);

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
      window.removeEventListener("pageshow", wake);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  // Real-time: the server pushes every change the moment it is saved
  useEffect(() => {
    if (!PUSHER_KEY || !PUSHER_CLUSTER) return;
    const pusher = new PusherClient(PUSHER_KEY, {
      cluster: PUSHER_CLUSTER,
      channelAuthorization: { endpoint: "/api/pusher/auth", transport: "ajax" },
    });
    const name = `presence-live-${code}`;
    const channel = pusher.subscribe(name) as PresenceChannel;

    pusher.connection.bind("state_change", (s: { current: string }) => {
      connectedRef.current = s.current === "connected" && channel.subscribed;
    });
    channel.bind("pusher:subscription_succeeded", () => {
      connectedRef.current = true;
      setPeers(channel.members.count);
      void fetchRef.current(); // catch up on anything missed while connecting
    });
    channel.bind("update", (data: { v: number; from: string; text?: string }) => {
      if (data.from === clientId.current) return; // my own edit
      lastActivityRef.current = Date.now();
      if (typeof data.text === "string") applyIfIdleRef.current(data.text, data.v);
      else void fetchRef.current(); // large text: fetch it
    });
    channel.bind("pusher:member_added", () => setPeers(channel.members.count));
    channel.bind("pusher:member_removed", () => setPeers(channel.members.count));
    channel.bind("deleted", () => setStatus("gone"));

    return () => {
      connectedRef.current = false;
      setPeers(null);
      channel.unbind_all();
      pusher.unsubscribe(name);
      pusher.disconnect();
    };
  }, [code]);

  // QR for the room link
  useEffect(() => {
    if (!showQr) return;
    const url = `${window.location.origin}/live/${code}`;
    QRCode.toDataURL(url, { margin: 1, width: 220 }).then(setQr).catch(() => setQr(""));
  }, [showQr, code]);

  function onChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const v = e.target.value;
    textRef.current = v;
    setText(v);
    dirtyRef.current = true;
    lastTypedRef.current = Date.now();
    lastActivityRef.current = Date.now();
    if (!saveTimer.current) scheduleSave(SAVE_DELAY);
  }

  function clearAll() {
    textRef.current = "";
    setText("");
    dirtyRef.current = true;
    lastTypedRef.current = Date.now();
    lastActivityRef.current = Date.now();
    scheduleSave(0);
  }

  async function leaveRoom() {
    // Save any unsent edit first so it isn't lost, then go back to the start page.
    if (saveTimer.current) clearTimeout(saveTimer.current);
    if (dirtyRef.current) {
      try {
        await fetch(`/api/live/${code}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: textRef.current, from: clientId.current }),
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
    status === "live" ? "Live, synced" : status === "offline" ? "Offline, retrying" : "Connecting…";

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
