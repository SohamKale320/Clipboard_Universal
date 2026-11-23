import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Clipboard — share text with a 6-digit code",
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
      <body>{children}</body>
    </html>
  );
}
