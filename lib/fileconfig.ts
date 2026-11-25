// Shared by server and client code. No imports here on purpose.
export const FILE_MAX = 50 * 1024 * 1024; // 50 MB
export const FILE_TTL = 15 * 60; // seconds a code works
export const MONTHLY_UPLOADS = 200; // site-wide cap, protects the free Blob quota
export const MULTIPART_ABOVE = 25 * 1024 * 1024;

export function safeName(name: string): string {
  const ext = name.match(/\.[A-Za-z0-9]{1,10}$/)?.[0] ?? "";
  const base = ext ? name.slice(0, -ext.length) : name;
  const clean = (s: string) =>
    s
      .normalize("NFC")
      .replace(/[\\/\u0000-\u001f]+/g, "_")
      .replace(/[^\p{L}\p{N}._\- ()]+/gu, "_");
  const cleanBase = clean(base).replace(/^\.+/, "").trim().slice(0, 100 - ext.length);
  return `${cleanBase || "file"}${clean(ext)}`;
}
