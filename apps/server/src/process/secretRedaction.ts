import {
  isHoldableSecretValue,
  redactSecrets,
  redactSecretsInValue,
} from "@octant/domain/secret-guard-policy";

/**
 * The values the credential broker handed out in this host process, so text
 * that carries one is redacted even when the value has no recognisable shape.
 * Held in memory only, never written anywhere, and bounded for fast per-chunk
 * transcript redaction: the oldest value drops out first.
 */
const issued = new Set<string>();
const ISSUED_LIMIT = 256;

/**
 * Uncapped in-memory set of secrets issued by the credential broker or OAuth
 * broker during this host process lifetime. Checked by the host push-label
 * scrubber so even a credential handed out more than 256 calls ago cannot leave
 * in a push payload. Never written anywhere or logged.
 */
const pushKnownSecrets = new Set<string>();

/**
 * Ended active thread secret forms retained in memory up to a cap so a secret
 * that a thread just finished using still cannot slip out in its completion
 * notification's title or label.
 */
const endedHeld = new Set<string>();
const ENDED_HELD_LIMIT = 512;

export function noteIssuedSecret(value: string): void {
  if (value.length === 0) return;
  issued.delete(value);
  issued.add(value);
  if (issued.size > ISSUED_LIMIT) {
    const oldest = issued.values().next().value;
    if (oldest !== undefined) issued.delete(oldest);
  }
  if (isHoldableSecretValue(value)) {
    for (const form of secretForms(value)) pushKnownSecrets.add(form);
  }
}

/**
 * The active thread secrets, held apart from the issued values: none may drop
 * out while a thread can still print it, and each leaves when its secret ends
 * (moving into `endedHeld` up to its cap for push-label checks). Counted, since
 * two threads may hold the same value.
 */
const held = new Map<string, number>();

/**
 * Redacts a value, and the forms a command most often prints it in, until the
 * returned release is called. A value that cannot be told from ordinary text
 * is not held.
 */
export function holdSecretValue(value: string): () => void {
  const forms = isHoldableSecretValue(value) ? secretForms(value) : [];
  for (const form of forms) held.set(form, (held.get(form) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const form of forms) {
      const count = (held.get(form) ?? 1) - 1;
      if (count <= 0) {
        held.delete(form);
        rememberEndedHeld(form);
      } else {
        held.set(form, count);
      }
    }
  };
}

function rememberEndedHeld(form: string): void {
  endedHeld.delete(form);
  endedHeld.add(form);
  if (endedHeld.size > ENDED_HELD_LIMIT) {
    const oldest = endedHeld.values().next().value;
    if (oldest !== undefined) endedHeld.delete(oldest);
  }
}

/**
 * All secret values and encoded forms currently known in host memory: uncapped
 * broker/OAuth secrets, active thread secrets, and recently ended thread
 * secrets. Used by the host-side push-label secret check; never logged or
 * serialized.
 */
export function readInMemoryHostSecrets(): ReadonlyArray<string> {
  const values = new Set<string>(pushKnownSecrets);
  for (const form of held.keys()) values.add(form);
  for (const form of endedHeld) values.add(form);
  return [...values];
}

/**
 * The value, its base64 at each of the three alignments it can have inside a
 * longer encoded text (`user:password` is the common one), and its URL and
 * JSON escapes. A form that is too short to replace is left out.
 */
export function secretForms(value: string): ReadonlyArray<string> {
  const bytes = Buffer.from(value, "utf8");
  // Half a surrogate pair cannot be URL-encoded; its UTF-8 bytes can.
  const encodedUrl = encodeURIComponent(bytes.toString("utf8"));
  const forms = new Set<string>([
    value,
    encodedUrl,
    encodedUrl.replaceAll("%20", "+"),
    JSON.stringify(value).slice(1, -1),
  ]);
  forms.add(value.trim());
  for (const line of value.split(/\r?\n/u))
    if (line.length >= MINIMUM_LINE_LENGTH && !isKeyFraming(line)) forms.add(line);
  for (const alignment of [0, 1, 2]) {
    const encoded = Buffer.concat([Buffer.alloc(alignment), bytes])
      .toString("base64")
      .replace(/=+$/u, "");
    // The characters that carry no bits of the bytes around the value.
    const start = Math.ceil((alignment * 8) / 6);
    const end = Math.floor(((alignment + bytes.length) * 8) / 6);
    const inner = encoded.slice(start, end);
    if (inner.length < MINIMUM_ENCODED_LENGTH) continue;
    forms.add(inner);
    forms.add(inner.replaceAll("+", "-").replaceAll("/", "_"));
  }
  return [...forms].filter(isHoldableSecretValue);
}

/** The lines every key of a format shares, which hide nothing of this one. */
function isKeyFraming(line: string): boolean {
  return line.startsWith("-----") || line.startsWith("PuTTY-User-Key-File-");
}

/** A key's own line is long; a short line of a multi-line value is ordinary text. */
const MINIMUM_LINE_LENGTH = 16;
/** Below this an encoded fragment is likely to appear in unrelated text. */
const MINIMUM_ENCODED_LENGTH = 8;

/** Text bound for tool output, a transcript, the journal, a log, or an export. */
export function redactHostSecrets(text: string): string {
  return redactSecrets(text, [...issued], [...held.keys()]).text;
}

/** Every string in a JSON-shaped value, keys left as they are. */
export function redactHostSecretsInValue<T>(value: T): T {
  return redactSecretsInValue(value, [...issued], [...held.keys()]);
}
