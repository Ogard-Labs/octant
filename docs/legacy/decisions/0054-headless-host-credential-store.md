# 0054. The credential broker is a host capability, not a desktop one

**Status:** Accepted

## Context

0031 accepts Linux headless hosts as a direction and names what one owes before
it can be an environment: confinement that replaces Seatbelt, and "a credential
store to replace Keychain" in an OS-provided secret store, where a host without
one **fails closed** — "no credential, no provider, rather than a file on disk
standing in for a keychain."

The credential path today cannot satisfy that on a host with no Electron. The
loopback broker service and the `CredentialStore` interface live in
`apps/desktop`, and 0004 assigns "Keychain and the credential broker" to that
application. `apps/server` never holds a secret store: it resolves credentials
only through `OCTANT_CREDENTIAL_BROKER_URL` and `OCTANT_CREDENTIAL_BROKER_TOKEN`,
and with no broker configured it builds no resolver at all. A headless host
started with `octant server run` therefore reaches the product with no way to
hold a provider credential — Chat renders and then reports, correctly but
terminally, that no provider is ready.

Two shapes were rejected. Teaching `apps/server` to talk to a secret store
directly would put credential material in the one process that spawns provider
and tool subprocesses, which is the separation the broker exists to create.
Building a second broker inside `packages/cli` would duplicate an
authorization-bearing service, and two copies of a loopback credential endpoint
is one more than can be reviewed as correct.

## Decision

- **The broker service and the `CredentialStore` seam are host-runtime
  capabilities.** The loopback service, its token and origin checks, its request
  bounds, and the `CredentialStore` / `CredentialStoreFailure` vocabulary live in
  `packages/host-runtime`. Exactly one implementation of the service exists.
- **A store is platform-owned; the service is not.** `apps/desktop` supplies the
  Keychain-backed store through the native helper. A headless host supplies an
  OS secret-store-backed store. Neither knows about the other, and the service
  knows about neither.
- **Scoped exception to 0004.** The rule assigning the credential broker to
  `apps/desktop` is superseded for the broker service only: `packages/cli` may
  own and start it for a host it launches. Every other rule of 0004 stands —
  `packages/cli` still opens no store of its own and is still not a second server
  owner, `apps/server` still holds no secret store, and packages still never
  import applications.
- **The host's own secret store, or nothing.** On Linux the store is the
  freedesktop Secret Service reached through libsecret. Probing is a fact, not an
  assumption: the service must answer on the session bus and the client tool must
  be present. A credential is written under a fixed service attribute keyed by
  provider instance id, and the secret crosses process boundaries on stdin —
  never in argv, never through a shell, never in a log.
- **Absence is a value, never a fallback.** A host with no usable secret store
  reports the `secret-store` capability `unavailable`, starts no broker, and
  passes no broker environment to the server. Providers then report their
  existing `unauthenticated` / `unavailable` readiness. There is no encrypted
  file, no plaintext file, and no in-memory store that outlives a process, at any
  verbosity or with any flag.
- **The credential never returns to the launcher.** `resolve` is reachable only
  through the loopback service under its bearer token, on the same terms as the
  desktop broker. The CLI process holds the store, not the credentials.

## Consequences

- A Linux station is usable for Chat exactly when the operator has a running
  Secret Service. That is a real prerequisite and it is documented as one; a
  cloud desktop or container without a session keyring gets an honest
  `unavailable`, which is the outcome 0031 asks for and not a bug to route
  around.
- Moving the service out of `apps/desktop` touches a security-bearing file. Its
  tests move with it unchanged, so the desktop's behaviour is asserted by the
  same assertions before and after.
- Work and Code remain incompatible on Linux for confinement reasons under 0009
  and 0048. This record makes credentials a solved problem for Chat; it does not
  weaken, and does not speak to, confinement.
- Windows gains a defined path — supply a store — without this record having to
  guess at one.

## Related

- 0004 Monorepo layering and dependency direction (scoped exception above)
- 0031 Hosts as environments
- 0005 Provider SDK contract, registry, and honest capabilities
- 0048 Linux Stations isolate Code work in execution capsules
