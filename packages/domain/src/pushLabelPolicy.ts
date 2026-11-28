import { isHoldableSecretValue, redactSecrets } from "./secretGuardPolicy";
import { looksLikeSecret } from "./secretShapedTextPolicy";

// Token prefixes run straight into the token, so only the words need a
// boundary after them; a trailing `\b` after `ghp_` never matched a token.
const SECRETISH =
  /\b(?:sk-|ghp_|github_pat_)|-----BEGIN|\b(?:password|api[_-]?key|authorization|bearer)\b/i;
const ABSOLUTE_PATH = /(?:^|[\s"'`])(?:\/(?:Users|home|private|var|tmp|etc)\/|\w:\\)/;

/**
 * Strips Unicode control characters, line/paragraph separators, and characters
 * that reorder or hide text (bidi marks, overrides, isolates), then collapses
 * whitespace. Applied on the host before secret checking and shortening so
 * hidden characters cannot split a secret or disguise a notification label.
 */
export function stripPushControlCharacters(value: string): string {
  let kept = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    if (
      (codePoint >= 0x00 && codePoint <= 0x1f) ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029 ||
      codePoint === 0x061c ||
      codePoint === 0x200e ||
      codePoint === 0x200f ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    ) {
      // Preserve word separation when stripping line breaks or tabs.
      if (
        codePoint === 0x09 ||
        codePoint === 0x0a ||
        codePoint === 0x0d ||
        codePoint === 0x2028 ||
        codePoint === 0x2029
      ) {
        kept += " ";
      }
      continue;
    }
    kept += character;
  }
  return kept.replace(/\s+/g, " ").trim();
}

/**
 * Single host-side check for every free-text field before it enters any push
 * payload (alert title, computer name, project name, device name, automation
 * name, or move destination name).
 *
 * Runs BEFORE shortening so a truncated secret prefix cannot slip past a
 * pattern or exact-value match. Drops the whole field (returning `undefined`)
 * when the text matches:
 * 1. `looksLikeSecret` (`secretShapedTextPolicy.ts`),
 * 2. any shape in `secretGuardPolicy.redactSecrets` (key prefixes, JWTs,
 *    private keys, PuTTY keys, basic-auth URLs, etc.),
 * 3. exact values of secrets Octant holds (`heldValues`, filtered by
 *    `isHoldableSecretValue`), or
 * 4. the push scrubber's `SECRETISH` or `ABSOLUTE_PATH` patterns.
 */
export function checkPushLabel(
  text: string | undefined,
  heldValues: ReadonlyArray<string>,
): string | undefined {
  if (text === undefined) return undefined;
  const cleaned = stripPushControlCharacters(text);
  if (cleaned.length === 0) return undefined;

  const usableHeld = heldValues.filter(isHoldableSecretValue);
  for (const candidate of text === cleaned ? [cleaned] : [text, cleaned]) {
    if (
      looksLikeSecret(candidate) ||
      SECRETISH.test(candidate) ||
      ABSOLUTE_PATH.test(candidate) ||
      redactSecrets(candidate, [], usableHeld).redacted
    ) {
      return undefined;
    }
  }
  return cleaned;
}
