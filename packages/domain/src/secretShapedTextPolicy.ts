/** A name a credential is written after, with any prefix such as `Proxy-`. */
const CREDENTIAL_LABEL = String.raw`["']?[\w-]{0,64}(?:refresh_token|access_token|api[_-]?key|token|authorization)["']?\s*[=:]`;
/** Refuses to cross whitespace of any kind into a credential's label. */
const BEFORE_ANOTHER_LABEL = String.raw`(?!\s+${CREDENTIAL_LABEL})`;
/**
 * Refuses to cross a line break into a credential's label. A value on the same
 * line may itself read like one (`token=mytoken:…`) and is still a value.
 */
const BEFORE_LATER_LABEL = String.raw`(?![^\S\r\n]*[\r\n]\s*${CREDENTIAL_LABEL})`;

/**
 * Text shaped like a credential: a bearer header, a key or token assignment,
 * a provider's own key prefix, or a webhook signing secret (Stripe's and
 * Standard Webhooks' `whsec_`, and the latter's private `whsk_`), whose
 * base64 may end in `=`. It is replaced before provider-composed text
 * crosses into anything Octant shows, keeps, or sends on, as the
 * provider-neutral floor under each runtime's own redaction. A scheme word
 * between a key and its value goes with the value: matching the word alone
 * left the credential after it in the text. A value is never another
 * credential's label, on a later line or after a scheme word: a token line
 * ending in `Bearer` took the next line's `Authorization:` as its value and
 * left that header's credential unmatched. A bare bearer token is matched
 * whole even when its characters spell something like `token=`; only a label
 * on a later line stops it.
 */
export const SECRET_SHAPED = new RegExp(
  [
    `bearer${BEFORE_LATER_LABEL}\\s+[A-Za-z0-9._~+/=-]{20,}`,
    `(?:refresh_token|access_token|api[_-]?key|token)\\s*[=:]${BEFORE_LATER_LABEL}\\s*(?:(?:bearer|basic)${BEFORE_ANOTHER_LABEL}\\s+)?\\S+`,
    `authorization\\s*:${BEFORE_LATER_LABEL}\\s*(?:(?:bearer|basic)${BEFORE_ANOTHER_LABEL}\\s+)?[^\\r\\n]+`,
    String.raw`\b(?:sk-[A-Za-z0-9_-]{16,}|gh[opusr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|lin_api_[A-Za-z0-9_]+|xox[abp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b`,
    String.raw`\bwh(?:sec|sk)_[A-Za-z0-9+/=_-]{16,}`,
  ].join("|"),
  "gi",
);

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

/** Every private-key block replaced, closed or not. */
export function redactPrivateKeys(text: string): string {
  return text.replaceAll(PRIVATE_KEY_BLOCK, "[redacted]");
}

/** Secret-shaped text and private-key blocks replaced: the checks person memory runs. */
export function redactSecretsAndPrivateKeys(text: string): string {
  return redactSecretShaped(redactPrivateKeys(text));
}

/** Whether the text holds anything those checks would replace. */
export function looksLikeSecret(text: string): boolean {
  return redactSecretsAndPrivateKeys(text) !== text;
}
