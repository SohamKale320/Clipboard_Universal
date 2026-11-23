export const LIVE_TTL = 60 * 60 * 24; // room is deleted after 24h without edits
export const LIVE_MAX = 200_000; // characters

export const vKey = (code: string) => `live:${code}:v`;
export const tKey = (code: string) => `live:${code}:t`;
