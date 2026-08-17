import type { UserProfile } from "@octant/contracts/user-profile";

/**
 * The letters an initials avatar shows.
 *
 * Two letters from the first and last word of the name, one when there is only
 * one word, and none when there is no name at all. An empty result is a real
 * answer: the surface draws a neutral person glyph rather than a letter the
 * user never gave.
 *
 * Word boundaries are Unicode-aware only to the extent of splitting on
 * whitespace and taking the first code point of each part, so names outside
 * the Latin alphabet keep their own first characters instead of being dropped.
 */
export function avatarInitials(displayName: string | undefined): string {
  const words = (displayName ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  const first = firstCodePoint(words[0] ?? "");
  if (words.length === 1) return first.toLocaleUpperCase();
  const last = firstCodePoint(words[words.length - 1] ?? "");
  return `${first}${last}`.toLocaleUpperCase();
}

function firstCodePoint(word: string): string {
  return [...word][0] ?? "";
}

/**
 * The exact string Gravatar hashes: trimmed and lower-cased.
 *
 * Gravatar treats addresses case-insensitively, so normalising here is what
 * makes a lookup for `Ada@Example.com` find the same picture as `ada@example.com`.
 */
export function normalizeGravatarEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * The Gravatar URL for an already-hashed address.
 *
 * Hashing happens at the edge that has a crypto implementation; this policy
 * stays pure and only assembles the request. `d=404` is deliberate: without it
 * Gravatar answers with a generated placeholder, and Octant would store an
 * invented picture while telling the user it found theirs.
 */
export function gravatarImageUrl(emailHashHex: string, sizePx: number): string {
  return `https://gravatar.com/avatar/${emailHashHex}?s=${String(sizePx)}&d=404`;
}

/**
 * Whether the profile has enough to attempt a Gravatar import.
 *
 * A lookup sends a hash of the address to gravatar.com, so it is offered only
 * when the user has actually entered an address — never derived from anything
 * else the host happens to know.
 */
export function canImportGravatar(profile: Pick<UserProfile, "email">): boolean {
  return profile.email !== undefined && profile.email.trim().length > 0;
}

/**
 * Whether first-run has been told anything worth keeping about the person.
 *
 * Used to describe the profile step honestly in a summary; it is never a gate.
 * Someone who wants no profile at all may finish first run with none.
 */
export function isProfileConfigured(profile: UserProfile): boolean {
  return (
    profile.displayName !== undefined ||
    profile.email !== undefined ||
    profile.avatar.kind === "image"
  );
}
