import { redactSecrets, redactSecretsInValue } from "@octant/domain/secret-guard-policy";

/**
 * The values the credential broker handed out in this host process, so text
 * that carries one is redacted even when the value has no recognisable shape.
 * Held in memory only, never written anywhere, and bounded: the oldest value
 * drops out first.
 */
const issued = new Set<string>();
const ISSUED_LIMIT = 256;

export function noteIssuedSecret(value: string): void {
  if (value.length === 0) return;
  issued.delete(value);
  issued.add(value);
  if (issued.size > ISSUED_LIMIT) {
    const oldest = issued.values().next().value;
    if (oldest !== undefined) issued.delete(oldest);
  }
}

/** Text bound for tool output, a transcript, the journal, a log, or an export. */
export function redactHostSecrets(text: string): string {
  return redactSecrets(text, [...issued]).text;
}

/** Every string in a JSON-shaped value, keys left as they are. */
export function redactHostSecretsInValue<T>(value: T): T {
  return redactSecretsInValue(value, [...issued]);
}
