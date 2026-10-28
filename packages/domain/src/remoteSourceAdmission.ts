/**
 * Which network source classes each remote listener gate admits.
 * Canonical: docs/design/hosted-relay.md § Authority over a relayed stream.
 *
 * A source class is a transport fact the host derives from the accepted
 * connection, never from a header. `relayed` is the class of a stream the
 * host's relay connector hands to the listener in process; no transport
 * produces it until that connector exists. A relayed device keeps its device
 * session's authority, so the table admits `relayed` wherever a device
 * session is established or used, and refuses it everywhere pairing happens:
 * first contact stays on a network the person controls.
 */

export type RemoteRequestSourceClass =
  | "loopback"
  | "lan-private"
  | "tailscale"
  | "relayed"
  | "unknown";

/**
 * - `hello`, `negotiation`, `auth-challenge`: the pre-authentication steps a
 *   paired device takes before every session.
 * - `session`: opening a device session or a dev-server proxy session.
 * - `authenticated`: any request carrying a device session, including the
 *   product API, the remote-auth routes, and the dev-server proxy.
 * - `pairing-claim`, `pairing-status`: claiming a ticket and reading its state.
 * - `pairing-ticket`: the source class the host mints a ticket for.
 * - `public-pre-auth`: the listener's other unauthenticated routes (health,
 *   the host list, the sandboxed design page).
 * - `static-asset`: the web client's files, which only a browser loads.
 */
export const REMOTE_SOURCE_GATES = [
  "hello",
  "negotiation",
  "auth-challenge",
  "session",
  "authenticated",
  "pairing-claim",
  "pairing-status",
  "pairing-ticket",
  "public-pre-auth",
  "static-asset",
] as const;
export type RemoteSourceGate = (typeof REMOTE_SOURCE_GATES)[number];

export type RemoteSourceAdmission =
  | { readonly status: "admitted" }
  | {
      readonly status: "refused";
      /**
       * `unclassified-source`: the peer address is neither private nor
       * relayed. `private-network-only`: the gate is reachable only from
       * loopback, private LAN, or Tailscale.
       */
      readonly reason: "unclassified-source" | "private-network-only";
    };

/**
 * The gates a relayed stream reaches. Public pre-authentication routes and
 * static assets refuse it as well as pairing: only a browser or a web view
 * uses them, and neither can hold pinned trust, so neither can use a relay.
 */
const RELAYED_GATES: ReadonlySet<RemoteSourceGate> = new Set<RemoteSourceGate>([
  "hello",
  "negotiation",
  "auth-challenge",
  "session",
  "authenticated",
]);

export function admitRemoteSource(
  gate: RemoteSourceGate,
  sourceClass: RemoteRequestSourceClass,
): RemoteSourceAdmission {
  switch (sourceClass) {
    case "loopback":
    case "lan-private":
    case "tailscale":
      return { status: "admitted" };
    case "relayed":
      return RELAYED_GATES.has(gate)
        ? { status: "admitted" }
        : { status: "refused", reason: "private-network-only" };
    case "unknown":
      return { status: "refused", reason: "unclassified-source" };
  }
}
