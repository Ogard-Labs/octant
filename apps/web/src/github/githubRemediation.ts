/**
 * The GitHub catalogue refuses with a remediation code; the code names what
 * the person has to do, not how to say it. Surfaces that showed the code
 * verbatim ("repository-access-or-scope-required") read as a stack trace.
 */
const REMEDIATION_COPY: Readonly<Record<string, string>> = {
  "repository-access-or-scope-required":
    "GitHub needs access to this repository, or the token is missing a scope.",
  "scope-or-authorization-required":
    "The GitHub token is missing a scope or authorization for this request.",
  "sso-authorization-required":
    "The organization requires single sign-on authorization for this token.",
  "unknown-repository-selection": "Choose a repository GitHub can find for this account.",
  "operation-probe-required": "GitHub has not confirmed this operation yet. Try again.",
};

export function describeGithubRemediation(remediation: string): string {
  const known = REMEDIATION_COPY[remediation];
  if (known !== undefined) return known;
  // A sentence already reads as one; a code does not.
  if (/\s/.test(remediation)) return remediation;
  const words = remediation.replaceAll("-", " ").trim();
  return words.length === 0 ? remediation : `${words[0]!.toUpperCase()}${words.slice(1)}.`;
}
