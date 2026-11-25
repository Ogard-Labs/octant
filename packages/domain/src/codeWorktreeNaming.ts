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

/** Files and folders whose names tell nothing a branch should carry. */
const PROTECTED_NAMES =
  /^(?:\.?env(?:\.[a-z0-9_-]+)?|id_(?:rsa|dsa|ecdsa|ed25519)|\.?ssh|\.?aws|\.?gnupg|\.?npmrc|\.?netrc|\.?git|\.?kube|\.?docker|credentials?|secrets?)$/i;

/** Names Windows reserves for devices, with or without an extension; a ref stored as a file cannot use them. */
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function isValidSegment(segment: string): boolean {
  return (
    segment.length > 0 &&
    !WINDOWS_RESERVED.test(segment.split(".")[0] ?? "") &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment) &&
    !segment.endsWith(".") &&
    !segment.endsWith(".lock") &&
    !segment.includes("..")
  );
}

/** The `git check-ref-format --branch` rules, narrowed to the characters Octant generates. */
export function isValidBranchName(name: string): boolean {
  // Git reserves HEAD as a branch name of its own.
  if (name.length === 0 || name.length > MAX_BRANCH_LENGTH || name === "HEAD") return false;
  return name.split("/").every(isValidSegment);
}

/** A prefix is a branch name's start: segments, optionally ending in `/`, `-` or `_`. */
export function isValidBranchPrefix(prefix: string): boolean {
  if (prefix.length === 0 || prefix.length > MAX_PREFIX_LENGTH) return false;
  const trimmed = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  return trimmed.split("/").every(isValidSegment);
}

/** Fold Norwegian letters and accents so the word lists below match them. */
function fold(text: string): string {
  return text
    .replaceAll("æ", "ae")
    .replaceAll("Æ", "AE")
    .replaceAll("ø", "o")
    .replaceAll("Ø", "O")
    .replaceAll("å", "a")
    .replaceAll("Å", "A")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "");
}

/**
 * Words that say a value follows: a short word can be an ordinary one, so these
 * match whole. A word on this list ends the clause for naming purposes.
 */
const SENSITIVE_WHOLE = new Set([
  "pass",
  "pwd",
  "pw",
  "key",
  "keys",
  "auth",
  "pin",
  "otp",
  "mfa",
  "bearer",
  "kode",
  "koden",
  "koder",
  "nokkel",
  "nokler",
  "hemmelig",
  "hemmelige",
  "passord",
  "token",
  "tokens",
  "login-code",
]);

/** Long, distinctive stems that are sensitive wherever they appear in a word. */
const SENSITIVE_STEM =
  /(?:password|passwd|passphrase|passord|secret|credential|apikey|privatekey|accesskey|authtoken|bearer|hemmelig|nokkel|nokler|token)/;

/** `login code`, `verification code`, and the like. */
const CODE_QUALIFIER = new Set([
  "login",
  "verification",
  "verify",
  "security",
  "recovery",
  "backup",
  "sms",
  "2fa",
  "mfa",
  "otp",
  "access",
  "sign-in",
  "signin",
]);

function wordsOf(token: string): string[] {
  return fold(token)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
}

function isSensitiveWord(word: string, previous: string | undefined): boolean {
  if (SENSITIVE_WHOLE.has(word) || SENSITIVE_STEM.test(word)) return true;
  return /^codes?$/.test(word) && previous !== undefined && CODE_QUALIFIER.has(previous);
}

/** Letters and digits in a short ordinary shape: v2, utf8, h264, oauth2, k8s, i18n, 2fa, 4k. */
function isOrdinaryAlphanumeric(word: string): boolean {
  return (
    /^[a-z]{1,6}\d{1,3}$/.test(word) ||
    /^\d{1,2}[a-z]{1,3}$/.test(word) ||
    /^[a-z]\d{1,2}[a-z]{1,2}$/.test(word)
  );
}

/** A token that is a URL, path, email, host or setting, none of which belongs in a branch name. */
function isLocator(token: string): boolean {
  return (
    token.includes("=") ||
    /[\\/~@]|:\/\/|^www\./i.test(token) ||
    token.startsWith(".") ||
    /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+[.,;:!?)]*$/.test(token) ||
    /[A-Za-z0-9]:\d{2,5}$/.test(token) ||
    /^(?:sk|pk|rk|ghp|gho|ghu|ghs|ghr|xox[a-z]|akia|aiza|ya29)[_-]/i.test(token)
  );
}

function keepWord(word: string, token: string): boolean {
  if (word.length > 30) return false;
  const hasLetter = /[a-z]/.test(word);
  const hasDigit = /\d/.test(word);
  if (hasLetter && hasDigit) return isOrdinaryAlphanumeric(word);
  // A number is kept as an issue or version number, never as a long digit run.
  if (!hasLetter) return word.length <= (token.startsWith("#") ? 7 : 4);
  return true;
}

/**
 * The words of a prompt that may become part of a branch name. A branch name is
 * pushed, so this keeps to what a person would not mind seeing on a remote:
 * after a word that says a secret follows (password, token, key, `DB_PASS`,
 * `login code`, Norwegian `passord`, `nøkkel`, `kode`) the rest of that clause is
 * dropped, and so is every URL, path, email, host, `name=value` setting, word
 * mixing letters and digits in an unusual shape, long number and protected file
 * name. A clause ends at a sentence stop or a line end; when a line ends inside
 * a clause that named a secret, the lines after it are left out too, up to a
 * blank line, since the value is often pasted there. The text is redacted
 * first, so a token shaped like a known key never gets this far.
 */
export function reducePromptForNaming(prompt: string): ReadonlyArray<string> {
  const redacted = redactSecretsAndPrivateKeys(prompt);
  const kept: string[] = [];
  // Set once a line ends inside a clause that says a secret follows: the value
  // may be on the lines after it.
  let value: "expected" | "passing" | undefined;
  for (const line of redacted.split(/\r?\n/)) {
    if (value !== undefined) {
      if (wordsOf(line).length > 0) value = "passing";
      else if (line.trim() === "" && value === "passing") value = undefined;
      continue;
    }
    for (const clause of line.split(/(?<=[.!?;])(?=\s|$)/)) {
      const withheld = keepClause(clause, kept);
      value = withheld && !/[.!?;]$/.test(clause) ? "expected" : undefined;
    }
  }
  return kept;
}

/** Adds the clause's safe words to `kept`; true when it named a secret and the rest was left out. */
function keepClause(clause: string, kept: string[]): boolean {
  let previous: string | undefined;
  for (const token of clause.split(/\s+/).filter((entry) => entry.length > 0)) {
    // The redactor found a secret here, so what follows it is not safe either.
    if (token.includes("[redacted]")) return true;
    // A path or address is left out alone; a `name=value` setting also tells
    // what its name is, so it is read for a sensitive word first.
    if (isLocator(token) && !token.includes("=")) continue;
    const parts = wordsOf(token);
    if (parts.some((word, index) => isSensitiveWord(word, parts[index - 1] ?? previous))) {
      return true;
    }
    previous = parts[parts.length - 1] ?? previous;
    if (isLocator(token) || PROTECTED_NAMES.test(token.replace(/[:=,.]+$/, ""))) continue;
    if (parts.some((word) => !keepWord(word, token))) continue;
    kept.push(...parts);
  }
  return false;
}

/** At least this many words, or the id name is used: a lone word says too little. */
const MIN_WORDS = 2;

/**
 * Lower-case, dash-joined words of the prompt, reduced as described for
 * `reducePromptForNaming`, or an empty string when too little is left.
 */
export function slugifyPrompt(prompt: string): string {
  const words = reducePromptForNaming(prompt);
  if (words.length < MIN_WORDS) return "";
  let slug = "";
  for (const word of words) {
    const next = slug.length === 0 ? word : `${slug}-${word}`;
    if (next.length > MAX_SLUG_LENGTH) break;
    slug = next;
  }
  return slug;
}

/**
 * The text a model is asked to name from: the reduced words only, so no clause
 * that was dropped for the branch name is sent either.
 */
export function promptForNameSuggestion(prompt: string, limit = 2_000): string {
  return reducePromptForNaming(prompt).join(" ").slice(0, limit);
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
  const id = safeId.length > 0 ? safeId : "new";
  const slug = input.naming === "prompt" ? slugifyPrompt(input.prompt ?? "") : "";
  const leaves = slug.length > 0 ? [slug, id] : [id];
  const taken = new Set(
    [input.baseBranch.trim(), ...(input.existingBranches ?? [])].map((name) => name.toLowerCase()),
  );
  // A branch or tag named like the prefix blocks every name below it, whatever
  // the number, so the prefix is then joined with a dash instead.
  for (const leaf of leaves) {
    for (const start of [prefix, prefix.replaceAll("/", "-")]) {
      for (let attempt = 1; attempt < 100; attempt += 1) {
        const candidate = attempt === 1 ? `${start}${leaf}` : `${start}${leaf}-${attempt}`;
        if (conflicts(candidate, taken)) continue;
        if (isValidBranchName(candidate)) return candidate;
        break;
      }
    }
  }
  return `${prefix}${id}`;
}
