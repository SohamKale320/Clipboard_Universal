"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LiveHome() {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [code, setCode] = useState("");

  async function createRoom() {
    setError("");
    setCreating(true);
    try {
      const res = await fetch("/api/live", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Something went wrong.");
      router.push(`/live/${data.code}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setCreating(false);
    }
  }

  function join() {
    if (!/^\d{6}$/.test(code)) {
      setError("Enter all 6 digits of the room code.");
      return;
    }
    router.push(`/live/${code}`);
  }

  return (
    <main className="shell">
      <header className="hero">
        <h1>
          <span className="l1">Live</span>
          <span className="l2">clipboard</span>
        </h1>
        <p className="tag">
          Open the same room on two devices. Whatever you type shows up on both, within about a second.
        </p>
      </header>

      <section className="panel">
        <button className="primary" onClick={createRoom} disabled={creating}>
          {creating ? "Creating room…" : "Start a new room"}
        </button>

        <p className="divider">or join one</p>

        <label className="field">
          <span className="lbl">Room code</span>
          <input
            className="input codein"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            onKeyDown={(e) => e.key === "Enter" && join()}
            placeholder="000000"
          />
        </label>
        <button className="secondary" onClick={join}>
          Join room
        </button>

        {error && <p className="err">{error}</p>}
      </section>

      <footer className="foot">
        Anyone with the code can read and edit the room. Rooms are deleted after 24 hours without edits.
      </footer>
    </main>
  );
}
