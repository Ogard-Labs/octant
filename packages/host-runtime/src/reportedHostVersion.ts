// The owner receipt rejects a server version longer than 64 characters.
const MAX_REPORTED_HOST_VERSION_LENGTH = 64;
const DEVELOPMENT_HOST_VERSION = "0.0.0-dev";

/**
 * Version a host reports on `/health`, in a diagnostics export, and on its
 * owner receipt.
 *
 * A packaged desktop launch and an installed headless artifact set
 * `OCTANT_ARTIFACT_VERSION`. A development run leaves that unset. The package
 * version a development script exports is used when present; otherwise the
 * host reports `0.0.0-dev`.
 */
export function resolveReportedHostVersion(
  env: Readonly<Record<string, string | undefined>>,
): string {
  return (
    acceptedReportedHostVersion(env.OCTANT_ARTIFACT_VERSION) ??
    acceptedReportedHostVersion(env.npm_package_version) ??
    DEVELOPMENT_HOST_VERSION
  );
}

/**
 * The trimmed version, or `undefined` when it is blank or too long to store on
 * the owner receipt. A launcher that hands a version to a host uses the same
 * rule, so the host never discards a version its launcher accepted.
 */
export function acceptedReportedHostVersion(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_REPORTED_HOST_VERSION_LENGTH) return undefined;
  return trimmed;
}
