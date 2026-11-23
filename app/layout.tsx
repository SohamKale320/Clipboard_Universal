import type { Metadata, Viewport } from "next";
import "./globals.css";
import Nav from "@/components/Nav";

export const metadata: Metadata = {
  title: "Clipboard — live and stored text sharing",
  description:
    "Paste text, get a 6-digit code, open it on any device. Clips expire automatically, can be passcode-protected, and can burn after reading.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="bg" aria-hidden="true" />
        <div className="frame">
          <Nav />
          {children}
        </div>
      </body>
    </html>
  );
}
