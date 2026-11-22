/**
 * Well-known host credentials that a provider launched outside Strict does not
 * inherit unless they are its own or the person lets them through for that
 * provider in Settings (maintainer decision, 2026-11-22). Outside Strict a
 * provider otherwise gets the person's environment as their shell has it, so a
 * `GH_TOKEN` or an AWS key exported for other work reached every agent's
 * commands with nothing to do with the agent itself.
 *
 * AWS profile names, regions and config-file paths are not on the list: they
 * name where a credential lives, not the credential, and a provider that
 * signs in through Bedrock reads them as its CLI does.
 */
const UNRELATED_HOST_CREDENTIAL_VARIABLES: ReadonlySet<string> = new Set([
  "AWS_ACCESS_KEY_ID",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SECURITY_TOKEN",
  "AWS_SESSION_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GH_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GITHUB_TOKEN",
  "GITLAB_TOKEN",
  "NODE_AUTH_TOKEN",
  "NPM_TOKEN",
]);

const API_KEY_SUFFIX = "_API_KEY";

/** Whether a host variable is a well-known credential a provider gets only when it is its own or let through. */
export function isUnrelatedHostCredential(name: string): boolean {
  const upper = name.toUpperCase();
  return UNRELATED_HOST_CREDENTIAL_VARIABLES.has(upper) || upper.endsWith(API_KEY_SUFFIX);
}

/**
 * Whether one host variable crosses into a provider launched outside Strict.
 * `own` names the credentials the provider itself signs in with, which are
 * never stripped; `passThrough` names what the person lets through for that
 * provider. Both hold upper-cased names, since Windows spells a variable in
 * any case.
 */
export function hostCredentialCrosses(
  name: string,
  lists: { readonly own: ReadonlySet<string>; readonly passThrough: ReadonlySet<string> },
): boolean {
  if (!isUnrelatedHostCredential(name)) return true;
  const upper = name.toUpperCase();
  return lists.own.has(upper) || lists.passThrough.has(upper);
}

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/**
 * Why a name cannot be on a provider's pass-through list, or undefined when it
 * can. Octant's own variables name the host's internal bridges and never reach
 * a provider, so letting one through is refused rather than silently ignored.
 */
export function hostCredentialPassThroughRefusal(name: string): string | undefined {
  if (!VARIABLE_NAME.test(name)) {
    return "Use an environment variable name: letters, digits and underscores, not starting with a digit.";
  }
  if (name.toUpperCase().startsWith("OCTANT_")) {
    return "Octant's own variables never reach a provider.";
  }
  return undefined;
}
