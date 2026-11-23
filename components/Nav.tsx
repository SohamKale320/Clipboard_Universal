"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export default function Nav() {
  const path = usePathname();
  const live = path.startsWith("/live");
  return (
    <nav className="nav" aria-label="Mode">
      <Link href="/live" className={live ? "navlink on" : "navlink"}>
        Live
      </Link>
      <Link href="/stored" className={!live ? "navlink on" : "navlink"}>
        Stored
      </Link>
    </nav>
  );
}
