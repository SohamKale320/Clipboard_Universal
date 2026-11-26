"use client";

import { useEffect, useRef, useState } from "react";
import { upload } from "@vercel/blob/client";
import QRCode from "qrcode";
import { FILE_MAX, MULTIPART_ABOVE, safeName } from "@/lib/fileconfig";

type Sent = { code: string; name: string; size: number; expiresAt: number; delToken: string };
type Found = { name: string; size: number; downloadUrl: string; expiresAt: number };

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatLeft(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export default function Files({ initialCode = "" }: { initialCode?: string }) {
  const [tab, setTab] = useState<"send" | "get">(initialCode ? "get" : "send");
  const [now, setNow] = useState(() => Date.now());

  // send
  const [file, setFile] = useState<File | null>(null);
  const [drag, setDrag] = useState(false);
  const [phase, setPhase] = useState<"idle" | "uploading">("idle");
  const [progress, setProgress] = useState(0);
  const [sendError, setSendError] = useState("");
  const [sent, setSent] = useState<Sent | null>(null);
  const [qr, setQr] = useState("");
  const [showQr, setShowQr] = useState(false);
  const [copied, setCopied] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  // get
  const [codeInput, setCodeInput] = useState(initialCode);
  const [found, setFound] = useState<Found | null>(null);
  const [getError, setGetError] = useState("");
  const [looking, setLooking] = useState(false);

  // one ticking clock for both countdowns
  useEffect(() => {
    if (!sent && !found) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [sent, found]);

  useEffect(() => {
    if (!sent || !showQr) return;
    QRCode.toDataURL(`${window.location.origin}/files/${sent.code}`, { margin: 1, width: 220 })
      .then(setQr)
      .catch(() => setQr(""));
  }, [sent, showQr]);

  // direct link: look the file up straight away (looking never uses it up)
  useEffect(() => {
    if (initialCode) void lookup(initialCode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function pick(f: File | undefined | null) {
    setSendError("");
    if (!f) return;
    if (f.size === 0) {
      setSendError("That file is empty.");
      return;
    }
    if (f.size > FILE_MAX) {
      setSendError(`That file is ${formatSize(f.size)}. The limit is 50 MB.`);
      return;
    }
    setFile(f);
  }

  async function startUpload() {
    if (!file) return;
    setSendError("");
    setPhase("uploading");
    setProgress(0);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const b = await fetch("/api/file/begin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ size: file.size }),
      });
      const begin = await b.json().catch(() => ({}));
      if (!b.ok) throw new Error(begin.error || "Could not start the upload.");

      const blob = await upload(`files/${begin.folder}/${safeName(file.name)}`, file, {
        access: "public",
        handleUploadUrl: "/api/file/upload",
        clientPayload: begin.ticket,
        multipart: file.size > MULTIPART_ABOVE,
        contentType: "application/octet-stream",
        abortSignal: ac.signal,
        onUploadProgress: (p) => setProgress(p.percentage),
      });

      const r = await fetch("/api/file/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: blob.url }),
      });
      const reg = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(reg.error || "Upload finished but the code could not be created.");

      setSent(reg);
      setNow(Date.now());
      setFile(null);
    } catch (e) {
      if (ac.signal.aborted) {
        setSendError("");
      } else {
        const msg = e instanceof Error ? e.message : "";
        setSendError(
          msg.includes("client token")
            ? "The upload was refused by the server. Try again in a moment. If it keeps happening, the Blob storage may not be set up correctly."
            : msg || "Upload failed. Try again."
        );
      }
    } finally {
      setPhase("idle");
      abortRef.current = null;
    }
  }

  async function deleteNow() {
    if (!sent) return;
    if (!window.confirm("Delete this file now? The code will stop working.")) return;
    try {
      const res = await fetch(`/api/file/${sent.code}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ delToken: sent.delToken }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setSendError(d.error || "Could not delete the file.");
        return;
      }
    } catch {
      setSendError("Could not reach the server. Try again.");
      return;
    }
    newFile();
  }

  function newFile() {
    setSent(null);
    setFile(null);
    setQr("");
    setShowQr(false);
    setSendError("");
    setProgress(0);
  }

  async function lookup(code: string) {
    setGetError("");
    setFound(null);
    if (!/^\d{6}$/.test(code)) {
      setGetError("Enter all 6 digits of the code.");
      return;
    }
    setLooking(true);
    try {
      const res = await fetch(`/api/file/${code}`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Something went wrong.");
      setFound(data);
      setNow(Date.now());
    } catch (e) {
      setGetError(e instanceof Error ? e.message : "Could not reach the server.");
    } finally {
      setLooking(false);
    }
  }

  async function copy(what: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(what);
      setTimeout(() => setCopied(""), 1500);
    } catch {
      setSendError("Copy failed. Select the text and copy it manually.");
    }
  }

  const sentLeft = sent ? sent.expiresAt - now : 0;
  const foundLeft = found ? found.expiresAt - now : 0;

  return (
    <main className="shell">
      <header className="hero">
        <h1>
          <span className="l1">Send</span>
          <span className="l2">a file</span>
        </h1>
        <p className="tag">Up to 50 MB. Gone after 15 minutes.</p>
      </header>

      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "send"} className={tab === "send" ? "tab on" : "tab"} onClick={() => setTab("send")}>
          Send
        </button>
        <button role="tab" aria-selected={tab === "get"} className={tab === "get" ? "tab on" : "tab"} onClick={() => setTab("get")}>
          Receive
        </button>
      </div>

      {tab === "send" && !sent && (
        <section className="panel">
          <label
            className={drag ? "drop over" : "drop"}
            onDragOver={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              if (phase === "idle") pick(e.dataTransfer.files?.[0]);
            }}
          >
            <input
              type="file"
              hidden
              disabled={phase === "uploading"}
              onChange={(e) => {
                pick(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            <span className="droptitle">{file ? "Choose a different file" : "Drop a file here or tap to choose"}</span>
            <span className="dropsub">Up to 50 MB · deleted after 15 minutes</span>
          </label>

          {file && (
            <div className="filerow">
              <div className="fileinfo">
                <span className="fname">{file.name}</span>
                <span className="fsize">{formatSize(file.size)}</span>
              </div>
            </div>
          )}

          {phase === "uploading" && (
            <div>
              <div className="bar" role="progressbar" aria-valuenow={Math.round(progress)} aria-valuemin={0} aria-valuemax={100}>
                <div className="fill" style={{ width: `${progress}%` }} />
              </div>
              <p className="meta" style={{ marginTop: 8 }}>
                Uploading… {Math.round(progress)}%
              </p>
            </div>
          )}

          {sendError && <p className="err">{sendError}</p>}

          {phase === "idle" ? (
            <button className="primary" onClick={startUpload} disabled={!file}>
              Upload and get code
            </button>
          ) : (
            <button className="secondary" onClick={() => abortRef.current?.abort()}>
              Cancel upload
            </button>
          )}
        </section>
      )}

      {tab === "send" && sent && (
        <section className="panel">
          <p className="lbl">Your code</p>
          <div className="code">
            {sent.code.slice(0, 3)} {sent.code.slice(3)}
          </div>

          <div className="filerow">
            <div className="fileinfo">
              <span className="fname">{sent.name}</span>
              <span className="fsize">{formatSize(sent.size)}</span>
            </div>
          </div>

          <p className="meta">
            {sentLeft > 0 ? `Expires in ${formatLeft(sentLeft)}` : "Expired. The code no longer works."}
          </p>

          <div className="row">
            <button className="secondary" onClick={() => copy("code", sent.code)}>
              {copied === "code" ? "Copied" : "Copy code"}
            </button>
            <button className="secondary" onClick={() => copy("link", `${window.location.origin}/files/${sent.code}`)}>
              {copied === "link" ? "Copied" : "Copy link"}
            </button>
          </div>
          <div className="row">
            <button className="secondary" onClick={() => setShowQr((s) => !s)}>
              {showQr ? "Hide QR code" : "Show QR code"}
            </button>
            <button className="secondary danger" onClick={deleteNow}>
              Delete now
            </button>
          </div>

          {showQr && qr && (
            <div className="qr">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={qr} alt="QR code linking to this file" width={220} height={220} />
              <p className="meta">Scan to open on your phone.</p>
            </div>
          )}

          {sendError && <p className="err">{sendError}</p>}

          <button className="primary" onClick={newFile}>
            Send another file
          </button>
        </section>
      )}

      {tab === "get" && (
        <section className="panel">
          {!found && (
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
                  onKeyDown={(e) => e.key === "Enter" && lookup(codeInput)}
                  placeholder="000000"
                  autoFocus={!initialCode}
                />
              </label>
              {getError && <p className="err">{getError}</p>}
              <button className="primary" onClick={() => lookup(codeInput)} disabled={looking}>
                {looking ? "Looking…" : "Find file"}
              </button>
            </>
          )}

          {found && (
            <>
              <div className="filerow">
                <div className="fileinfo">
                  <span className="fname">{found.name}</span>
                  <span className="fsize">{formatSize(found.size)}</span>
                </div>
              </div>
              <p className="meta">
                {foundLeft > 0 ? `Available for ${formatLeft(foundLeft)}` : "Expired. This file is no longer available."}
              </p>
              {foundLeft > 0 ? (
                <a className="primary" href={found.downloadUrl} download>
                  Download
                </a>
              ) : null}
              <button
                className="secondary"
                onClick={() => {
                  setFound(null);
                  setCodeInput("");
                  setGetError("");
                }}
              >
                Use another code
              </button>
            </>
          )}
        </section>
      )}
    </main>
  );
}
