/**
 * Pure naming of the branch a new managed Code worktree delivers on: a
 * configurable prefix and a slug of the person's own prompt, derived on this
 * machine with no model call. The caller supplies the branches that already
 * exist so the name shown before Send is the name the worktree gets.
 */
import { redactSecretsAndPrivateKeys } from "./secretShapedTextPolicy";

export const DEFAULT_BRANCH_PREFIX = "octant/";
export type BranchNaming = "short-id" | "prompt";

const MAX_SLUG_LENGTH = 40;
const MAX_BRANCH_LENGTH = 120;
const MAX_PREFIX_LENGTH = 40;

/** Words that mark the next word as a value to keep out of a branch name. */
const SENSITIVE_WORDS = new Set([
  "password",
  "passwd",
  "passphrase",
  "secret",
  "secrets",
  "token",
  "tokens",
  "credential",
  "credentials",
  "apikey",
  "api_key",
  "privatekey",
]);

/** Files and folders whose names tell nothing a branch should carry. */
const PROTECTED_NAMES =
  /^(?:\.?env(?:\.[a-z0-9_-]+)?|id_(?:rsa|dsa|ecdsa|ed25519)|\.?ssh|\.?aws|\.?gnupg|\.?npmrc|\.?netrc|\.?git|\.?kube|\.?docker|credentials?|secrets?)$/i;

function isValidSegment(segment: string): boolean {
  return (
    segment.length > 0 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment) &&
    !segment.endsWith(".") &&
    !segment.endsWith(".lock") &&
    !segment.includes("..")
  );
}

/** The `git check-ref-format --branch` rules, narrowed to the characters Octant generates. */
export function isValidBranchName(name: string): boolean {
  if (name.length === 0 || name.length > MAX_BRANCH_LENGTH) return false;
  return name.split("/").every(isValidSegment);
}

/** A prefix is a branch name's start: segments, optionally ending in `/`, `-` or `_`. */
export function isValidBranchPrefix(prefix: string): boolean {
  if (prefix.length === 0 || prefix.length > MAX_PREFIX_LENGTH) return false;
  const trimmed = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  return trimmed.split("/").every(isValidSegment);
}

function looksLikeKey(word: string): boolean {
  return word.length >= 24 && /[0-9]/.test(word) && /[A-Za-z]/.test(word);
}

/** Lower-case words of the prompt, without secrets, paths or protected names. */
export function slugifyPrompt(prompt: string): string {
  const cleaned = redactSecretsAndPrivateKeys(prompt).replaceAll("[redacted]", " ");
  const tokens = cleaned.split(/\s+/).filter((token) => token.length > 0);
  const kept: string[] = [];
  let skipValue = false;
  for (const token of tokens) {
    if (skipValue) {
      skipValue = false;
      continue;
    }
    const bare = token.replace(/[:=]+$/, "");
    if (SENSITIVE_WORDS.has(bare.toLowerCase())) {
      skipValue = bare !== token;
      continue;
    }
    if (/[\\/~@]|:\/\//.test(token) || token.startsWith(".")) continue;
    if (PROTECTED_NAMES.test(bare) || looksLikeKey(bare)) continue;
    const words = token
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .split("-")
      .filter((word) => word.length > 0);
    kept.push(...words);
  }
  let slug = "";
  for (const word of kept) {
    const next = slug.length === 0 ? word : `${slug}-${word}`;
    if (next.length > MAX_SLUG_LENGTH) break;
    slug = next;
  }
  return slug;
}

/** Whether a branch of this name, or one above or below it, already exists (ignoring case). */
export function branchNameTaken(candidate: string, existing: ReadonlyArray<string>): boolean {
  return conflicts(candidate, new Set(existing.map((name) => name.toLowerCase())));
}

export interface DeliveryBranchInput {
  readonly baseBranch: string;
  readonly shortId: string;
  readonly prefix?: string | undefined;
  readonly naming?: BranchNaming | undefined;
  readonly prompt?: string | undefined;
  /** Local branch names that exist now; a taken name gets a number. */
  readonly existingBranches?: ReadonlyArray<string> | undefined;
}

function conflicts(candidate: string, taken: ReadonlySet<string>): boolean {
  const lower = candidate.toLowerCase();
  for (const name of taken) {
    if (name === lower || name.startsWith(`${lower}/`) || lower.startsWith(`${name}/`)) {
      return true;
    }
  }
  return false;
}

/**
 * The delivery branch for a new worktree. Short-id naming with the default
 * prefix is the name every install has always had; a saved prefix that is not
 * a usable branch start is ignored rather than trusted.
 */
export function deriveDeliveryBranch(input: DeliveryBranchInput): string {
  const prefix =
    input.prefix !== undefined && isValidBranchPrefix(input.prefix)
      ? input.prefix
      : DEFAULT_BRANCH_PREFIX;
  const safeId = input.shortId
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 12);
  const idName = `${prefix}${safeId.length > 0 ? safeId : "new"}`;
  const slug = input.naming === "prompt" ? slugifyPrompt(input.prompt ?? "") : "";
  const stem = slug.length > 0 ? `${prefix}${slug}` : idName;
  const taken = new Set(
    [input.baseBranch.trim(), ...(input.existingBranches ?? [])].map((name) => name.toLowerCase()),
  );
  let candidate = stem;
  for (let attempt = 2; conflicts(candidate, taken) && attempt < 100; attempt += 1) {
    candidate = `${stem}-${attempt}`;
  }
  return isValidBranchName(candidate) && !conflicts(candidate, taken) ? candidate : idName;
}
