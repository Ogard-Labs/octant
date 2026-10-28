// How long the credential broker waits on any request to an identity issuer
// or a cloud portal (discovery, device authorization, device-code polls, code
// exchanges, refreshes, key sets, role credentials, sign-out) for its whole
// answer, body included. Without a bound, one hung device-code poll kept its
// attempt awaiting consent forever, where neither the code's expiry nor
// pruning could end it, and one hung refresh would hold every send waiting on
// that grant's single-flight renewal.
const ISSUER_REQUEST_TIMEOUT_MS = 30_000;

/**
 * The deadline every issuer and portal request carries. A request still
 * unanswered when it passes is abandoned, and its caller reads it as no
 * answer at all.
 */
export function issuerRequestDeadline(): AbortSignal {
  return AbortSignal.timeout(ISSUER_REQUEST_TIMEOUT_MS);
}
