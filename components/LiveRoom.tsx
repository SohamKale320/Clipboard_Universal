"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import QRCode from "qrcode";

type Status = "connecting" | "live" | "offline" | "gone";

const SAVE_DELAY = 250; // ms after last keystroke
const FAST_POLL = 500;
const SLOW_POLL = 3000;
const QUIET_AFTER = 15000;

export default function LiveRoom({ code }: { code: string }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [status, setStatus] = useState<Status>("connecting");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const [showQr, setShowQr] = useState(false);
  const [qr, setQr] = useState("");

  const taRef = useRef<HTMLTextAreaElement>(null);
  const textRef = useRef("");
  const versionRef = useRef(-1);
  const dirtyRef = useRef(false);
  const lastTypedRef = useRef(0);
  const lastActivityRef = useRef(Date.now());
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);
  const saveRef = useRef<() => void>(() => {});

  function scheduleSave(delay: number) {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => saveRef.current(), delay);
  }

  // Latest save function lives in a ref so retries always call the current one.
  saveRef.current = async () => {
    if (savingRef.current) {
      scheduleSave(300);
      return;
    }
    const snapshot = textRef.current;
    savingRef.current = true;
    try {
      const res = await fetch(`/api/live/${code}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: snapshot }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        versionRef.current = data.v;
        setStatus("live");
        setError("");
        if (textRef.current === snapshot) {
          dirtyRef.current = false;
        } else {
          scheduleSave(SAVE_DELAY); // typed more while saving
        }
      } else if (res.status === 404) {
        setStatus("gone");
      } else {
        setError(data.error || "Could not save your last change.");
        scheduleSave(4000);
      }
    } catch {
      setStatus("offline");
      scheduleSave(4000); // keep dirty, retry
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

  // Polling loop
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
      let delay = FAST_POLL;
      try {
        const res = await fetch(`/api/live/${code}?v=${versionRef.current}`, { cache: "no-store" });
        if (res.status === 404) {
          setStatus("gone");
          running = false;
          return; // stop polling, room is gone
        }
        if (res.status === 429) {
          delay = 5000;
        } else if (res.ok) {
          const data = await res.json();
          setStatus("live");
          if (data.changed) {
            lastActivityRef.current = Date.now();
            const idle = Date.now() - lastTypedRef.current > 800;
            if (!dirtyRef.current && idle) applyRemote(data.text, data.v);
          }
        } else {
          delay = 4000;
        }
      } catch {
        setStatus("offline");
        delay = 4000;
      }
      running = false;
      if (stopped) return;
      const quiet =
        Date.now() - Math.max(lastActivityRef.current, lastTypedRef.current) > QUIET_AFTER;
      if (delay === FAST_POLL && quiet) delay = SLOW_POLL;
      timer = setTimeout(poll, delay);
    }

    poll();

    const onVisible = () => {
      if (!document.hidden && !running) {
        if (timer) clearTimeout(timer);
        poll();
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    scheduleSave(SAVE_DELAY);
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
          body: JSON.stringify({ text: textRef.current }),
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
        <header className="top">
          <h1 className="brand">Room not found</h1>
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
      <header className="top livehead">
        <p className="lbl">Live room</p>
        <div className="livecode" aria-label={`Room ${code.split("").join(" ")}`}>
          {code.slice(0, 3)} {code.slice(3)}
        </div>
      </header>

      <section className="panel">
        <div className="statusbar">
          <span className={`dot ${status === "live" ? "live" : status === "offline" ? "offline" : ""}`} />
          <span>{statusText}</span>
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

      <footer className="foot">
        Anyone with this code can read and edit the room. If two people type at once, the last edit wins.
        The room is deleted after 24 hours without edits.
      </footer>
    </main>
  );
}
