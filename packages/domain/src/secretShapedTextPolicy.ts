/**
 * Text shaped like a credential: a bearer header, a key or token assignment,
 * or a provider's own key prefix. It is replaced before provider-composed text
 * crosses into anything Octant shows, keeps, or sends on, as the
 * provider-neutral floor under each runtime's own redaction.
 */
export const SECRET_SHAPED =
  /(?:bearer\s+[A-Za-z0-9._-]{20,}|(?:refresh_token|access_token|api[_-]?key|token)\s*[=:]\s*\S+|authorization\s*:\s*[^\r\n]+|\b(?:sk-[A-Za-z0-9_-]{16,}|gh[opusr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|lin_api_[A-Za-z0-9_]+|xox[abp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b)/gi;

/** A private key's armoured block, closed or running to the end of the text. */
const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;

/** Replaces every credential-shaped run in `text`, repeating until none is left. */
export function redactSecretShaped(text: string): string {
  let redacted = text;
  for (let pass = 0; pass < 5; pass += 1) {
    SECRET_SHAPED.lastIndex = 0;
    if (!SECRET_SHAPED.test(redacted)) break;
    redacted = redacted.replaceAll(SECRET_SHAPED, "[redacted]");
  }
  return redacted;
}

/** Secret-shaped text and private-key blocks replaced: the checks person memory runs. */
export function redactSecretsAndPrivateKeys(text: string): string {
  return redactSecretShaped(text.replaceAll(PRIVATE_KEY_BLOCK, "[redacted]"));
}

/** Whether the text holds anything those checks would replace. */
export function looksLikeSecret(text: string): boolean {
  return redactSecretsAndPrivateKeys(text) !== text;
}
