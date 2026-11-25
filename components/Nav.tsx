"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export default function Nav() {
  const path = usePathname();
  const mode = path.startsWith("/live") ? "live" : path.startsWith("/files") ? "files" : "stored";
  const cls = (m: string) => (mode === m ? "segbtn on" : "segbtn");
  return (
    <header className="appbar">
      <div className="appmark" aria-hidden="true">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="5" y="4" width="14" height="17" rx="3" />
          <path d="M9 4.5h6v2.5H9z" />
          <path d="M8.5 12h7M8.5 15.5h4.5" />
        </svg>
      </div>
      <span className="appname">Clipboard</span>
      <nav className="seg" aria-label="Mode">
        <Link href="/live" className={cls("live")}>
          Live
        </Link>
        <Link href="/files" className={cls("files")}>
          Files
        </Link>
        <Link href="/stored" className={cls("stored")}>
          Stored
        </Link>
      </nav>
    </header>
  );
}
