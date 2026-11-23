"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";

const EXPIRIES = [
  { value: "5m", label: "5 minutes" },
  { value: "1h", label: "1 hour" },
  { value: "1d", label: "1 day" },
  { value: "1w", label: "1 week" },
  { value: "1m", label: "1 month" },
  { value: "1y", label: "1 year" },
];

function formatCode(code: string) {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export default function Clipboard({ initialCode = "" }: { initialCode?: string }) {
  const [tab, setTab] = useState<"send" | "get">(initialCode ? "get" : "send");

  // send state
  const [text, setText] = useState("");
  const [expiry, setExpiry] = useState("1d");
  const [usePass, setUsePass] = useState(false);
  const [passcode, setPasscode] = useState("");
  const [burn, setBurn] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const [created, setCreated] = useState<{ code: string; expiry: string; burn: boolean } | null>(null);
  const [qr, setQr] = useState("");
  const [copiedWhat, setCopiedWhat] = useState("");

  // get state
  const [codeInput, setCodeInput] = useState(initialCode);
  const [needPass, setNeedPass] = useState(false);
  const [getPass, setGetPass] = useState("");
  const [getting, setGetting] = useState(false);
  const [getError, setGetError] = useState("");
  const [fetched, setFetched] = useState<{ text: string; burned: boolean } | null>(null);
  const [copiedText, setCopiedText] = useState(false);

  useEffect(() => {
    if (!created) return;
    const url = `${window.location.origin}/${created.code}`;
    QRCode.toDataURL(url, { margin: 1, width: 220 }).then(setQr).catch(() => setQr(""));
  }, [created]);

  function flash(what: string) {
    setCopiedWhat(what);
    setTimeout(() => setCopiedWhat(""), 1500);
  }

  async function createClip() {
    setSendError("");
    setSending(true);
    try {
      const res = await fetch("/api/clip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          expiry,
          burn,
          passcode: usePass ? passcode : "",
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Something went wrong.");
      setCreated({ code: data.code, expiry, burn });
    } catch (e) {
      setSendError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setSending(false);
    }
  }

  function newClip() {
    setCreated(null);
    setQr("");
    setText("");
    setPasscode("");
    setUsePass(false);
    setBurn(false);
  }

  async function openClip() {
    setGetError("");
    setFetched(null);
    if (!/^\d{6}$/.test(codeInput)) {
      setGetError("Enter all 6 digits of the code.");
      return;
    }
    setGetting(true);
    try {
      const res = await fetch(`/api/clip/${codeInput}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passcode: getPass }),
      });
      const data = await res.json();
      if (res.ok) {
        setFetched({ text: data.text, burned: !!data.burned });
        setNeedPass(false);
        setGetPass("");
      } else {
        if (data.locked) setNeedPass(true);
        setGetError(data.error || "Something went wrong.");
      }
    } catch {
      setGetError("Could not reach the server. Check your connection.");
    } finally {
      setGetting(false);
    }
  }

  const expiryLabel = (v: string) => EXPIRIES.find((e) => e.value === v)?.label ?? v;

  return (
    <main className="shell">
      <header className="top">
        <h1 className="brand">Clipboard</h1>
        <p className="tag">Paste text here, open it on any other device with a 6-digit code.</p>
      </header>

      <div className="tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === "send"}
          className={tab === "send" ? "tab on" : "tab"}
          onClick={() => setTab("send")}
        >
          Send
        </button>
        <button
          role="tab"
          aria-selected={tab === "get"}
          className={tab === "get" ? "tab on" : "tab"}
          onClick={() => setTab("get")}
        >
          Open
        </button>
      </div>

      {tab === "send" && !created && (
        <section className="panel">
          <label className="field">
            <span className="lbl">Text</span>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Paste a note, link, or snippet"
              rows={9}
              maxLength={200000}
            />
          </label>

          <div className="row">
            <label className="field grow">
              <span className="lbl">Delete after</span>
              <select value={expiry} onChange={(e) => setExpiry(e.target.value)}>
                {EXPIRIES.map((e) => (
                  <option key={e.value} value={e.value}>
                    {e.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="check">
            <input type="checkbox" checked={usePass} onChange={(e) => setUsePass(e.target.checked)} />
            <span>Require a passcode</span>
          </label>
          {usePass && (
            <input
              className="input"
              type="password"
              value={passcode}
              onChange={(e) => setPasscode(e.target.value)}
              placeholder="Passcode"
              autoComplete="off"
              maxLength={100}
            />
          )}

          <label className="check">
            <input type="checkbox" checked={burn} onChange={(e) => setBurn(e.target.checked)} />
            <span>Delete as soon as it is opened once</span>
          </label>

          {sendError && <p className="err">{sendError}</p>}

          <button
            className="primary"
            onClick={createClip}
            disabled={sending || !text.trim() || (usePass && !passcode)}
          >
            {sending ? "Creating…" : "Get 6-digit code"}
          </button>
        </section>
      )}

      {tab === "send" && created && (
        <section className="panel">
          <p className="lbl">Your code</p>
          <div className="code" aria-label={`Code ${created.code.split("").join(" ")}`}>
            {formatCode(created.code)}
          </div>
          <p className="meta">
            Deleted after {expiryLabel(created.expiry)}
            {created.burn ? " or when opened once, whichever comes first." : "."}
          </p>

          <div className="row">
            <button
              className="secondary"
              onClick={async () => {
                if (await copy(created.code)) flash("code");
              }}
            >
              {copiedWhat === "code" ? "Copied" : "Copy code"}
            </button>
            <button
              className="secondary"
              onClick={async () => {
                if (await copy(`${window.location.origin}/${created.code}`)) flash("link");
              }}
            >
              {copiedWhat === "link" ? "Copied" : "Copy link"}
            </button>
          </div>

          {qr && (
            <div className="qr">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={qr} alt="QR code linking to this clip" width={220} height={220} />
              <p className="meta">Scan to open on your phone.</p>
            </div>
          )}

          <button className="primary" onClick={newClip}>
            New clip
          </button>
        </section>
      )}

      {tab === "get" && (
        <section className="panel">
          {!fetched && (
            <>
              <label className="field">
                <span className="lbl">6-digit code</span>
                <input
                  className="input codein"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={6}
                  value={codeInput}
                  onChange={(e) => setCodeInput(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  onKeyDown={(e) => e.key === "Enter" && openClip()}
                  placeholder="000000"
                  autoFocus={!initialCode}
                />
              </label>

              {needPass && (
                <label className="field">
                  <span className="lbl">Passcode</span>
                  <input
                    className="input"
                    type="password"
                    value={getPass}
                    onChange={(e) => setGetPass(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && openClip()}
                    autoComplete="off"
                    autoFocus
                  />
                </label>
              )}

              {getError && <p className="err">{getError}</p>}

              <button className="primary" onClick={openClip} disabled={getting}>
                {getting ? "Opening…" : "Open clip"}
              </button>
            </>
          )}

          {fetched && (
            <>
              {fetched.burned && (
                <p className="warn">This clip has been deleted. Copy it now, it can&apos;t be opened again.</p>
              )}
              <pre className="out">{fetched.text}</pre>
              <div className="row">
                <button
                  className="primary"
                  onClick={async () => {
                    if (await copy(fetched.text)) {
                      setCopiedText(true);
                      setTimeout(() => setCopiedText(false), 1500);
                    }
                  }}
                >
                  {copiedText ? "Copied" : "Copy text"}
                </button>
                <button
                  className="secondary"
                  onClick={() => {
                    setFetched(null);
                    setCodeInput("");
                    setGetError("");
                  }}
                >
                  Open another
                </button>
              </div>
            </>
          )}
        </section>
      )}

      <footer className="foot">
        Clips are stored temporarily and deleted when they expire. Don&apos;t put anything here you can&apos;t afford to lose.
      </footer>
    </main>
  );
}
