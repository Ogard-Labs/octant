/**
 * Cloud credential shapes that untrusted text (an issue body, a comment) may
 * carry. An access key id is self-identifying; a secret access key is 40 base64
 * characters with no marker of its own, so it is redacted only when the text
 * names it (`aws_secret_access_key=`, "secret key is"), never by length alone.
 */
const AWS_ACCESS_KEY_ID = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g;
const AWS_SECRET_ACCESS_KEY =
  /\b(?:aws[_\s-]?)?secret(?:[_\s-]?access)?(?:[_\s-]?key)?\b['":=\s]+(?:is\s+)?[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/gi;

export function redactAwsCredentialShapes(value: string, replacement: string): string {
  return value
    .replaceAll(AWS_SECRET_ACCESS_KEY, replacement)
    .replaceAll(AWS_ACCESS_KEY_ID, replacement);
}
