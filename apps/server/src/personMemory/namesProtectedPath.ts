/** Path-shaped runs in text: home-relative (`~`, `$HOME`, `${HOME}`) or absolute. */
const PATH_SHAPED = /(?:~|\$HOME|\$\{HOME\})?\/[^\s"'`<>()]+/g;

/** Whether text names a path the secret guard protects, ignoring punctuation that ends a sentence. */
export function namesProtectedPath(
  text: string,
  protectedSecretPath: (path: string) => boolean,
): boolean {
  return [...text.matchAll(PATH_SHAPED)].some((match) =>
    protectedSecretPath(match[0].replace(/[.,;:!?'"]+$/u, "")),
  );
}
