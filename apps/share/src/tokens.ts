import { createHmac, timingSafeEqual } from "node:crypto";

export const VIEW_GRANT_TTL_MS = 3_600_000;
export const FRAME_TOKEN_TTL_MS = 600_000;

/** Whether a frame is served under the static policy or the script-running one. */
export type FrameMode = "static" | "running";

function sign(key: Buffer, purpose: string, parts: ReadonlyArray<string>): string {
  return createHmac("sha256", key)
    .update([purpose, ...parts].join("|"))
    .digest("base64url");
}

function signaturesMatch(expected: string, presented: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
}

function splitToken(token: string, fields: number): ReadonlyArray<string> | undefined {
  const parts = token.split(".");
  return parts.length === fields && parts.every((part) => part !== "") ? parts : undefined;
}

/**
 * A view grant proves a viewer entered the link's password. It names the
 * link's revision, so an update (which can change the password or the content)
 * voids every grant issued before it.
 */
export function mintViewGrant(key: Buffer, shareId: string, revision: number, now: number): string {
  const expires = String(now + VIEW_GRANT_TTL_MS);
  return `${expires}.${sign(key, "view", [shareId, String(revision), expires])}`;
}

export function viewGrantIsValid(
  key: Buffer,
  shareId: string,
  revision: number,
  now: number,
  token: string,
): boolean {
  const parts = splitToken(token, 2);
  const [expires, signature] = parts ?? [];
  if (expires === undefined || signature === undefined) return false;
  if (!(Number(expires) > now)) return false;
  return signaturesMatch(sign(key, "view", [shareId, String(revision), expires]), signature);
}

/** A frame address token: for one link, revision, block and mode, for a few minutes. */
export function mintFrameToken(
  key: Buffer,
  shareId: string,
  revision: number,
  blockId: string,
  mode: FrameMode,
  now: number,
): string {
  const expires = String(now + FRAME_TOKEN_TTL_MS);
  const signature = sign(key, "frame", [shareId, String(revision), blockId, mode, expires]);
  return `${mode}.${expires}.${signature}`;
}

/** The mode a valid token was minted for, or undefined for a forged, stale, or expired one. */
export function readFrameToken(
  key: Buffer,
  shareId: string,
  revision: number,
  blockId: string,
  now: number,
  token: string,
): FrameMode | undefined {
  const parts = splitToken(token, 3);
  const [mode, expires, signature] = parts ?? [];
  if (mode === undefined || expires === undefined || signature === undefined) return undefined;
  if (mode !== "static" && mode !== "running") return undefined;
  if (!(Number(expires) > now)) return undefined;
  const expected = sign(key, "frame", [shareId, String(revision), blockId, mode, expires]);
  return signaturesMatch(expected, signature) ? mode : undefined;
}
