# Enterprise provider identity and cloud-IAM endpoints

Design only. Does not authorize implementation. Connector/OAuth marketplace
stays Later per the Current Release Boundary in `AGENTS.md` and
[roadmap Later](roadmap.md#later).

Today Octant authenticates providers two ways ([0005](decisions/0005-provider-sdk-contract.md)):

1. Provider-native OAuth or subscription login, delegated to the provider's own
   protocol or UI. Octant never stores those tokens.
2. Explicit API keys held as opaque refs in the host credential broker
   ([0054](decisions/0054-headless-host-credential-store.md)). The renderer never
   sees the secret.

Enterprise buyers also need directory ID/OAuth (for example Entra) and
cloud-IAM-signed calls to model endpoints (for example Bedrock with IAM). Those
are not API keys and not the provider CLI's own login. This note says how they
enter without widening a seam for one vendor.

## Seam: extend vs reuse

**Reuse the credential broker host, not the raw-string resolve shape.**
Secrets and short-lived material still live in the host secret store. Server
still reaches the broker only through `OCTANT_CREDENTIAL_BROKER_*`. Cloud-IAM
must not reuse `CredentialStore.resolve` / `/v1/credentials/resolve` as-is:
that path returns a raw `credential` string suitable for opaque API-key refs,
not for reusable cloud credentials. The IAM extension defines its own caller,
response type, scope, and lifetime — prefer a broker-side signer or an opaque,
scoped handle that never places reusable cloud credentials in a provider child
process. Drivers never hold durable tokens in process state that outlives a
request.

**Extend the provider SDK, not a vendor shortcut.** New auth kinds are
provider-neutral capability and readiness vocabulary on the existing driver
contract:

| Need                                      | Prefer                                                                                                                                    | Avoid                                                                                                    |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Directory ID / OAuth for a model endpoint | Driver-declared auth kind; browser or device flow owned by the host; broker stores refresh/access as opaque refs                          | Embedding one IdP SDK in `apps/server`; journaling tokens                                                |
| Cloud-IAM request signing                 | Driver asks the broker (or a broker-backed signer) for a short-lived signature or session; endpoint config stays in the registry instance | Shipping cloud SDK credentials into provider child env verbatim; teaching the server a vendor IAM client |
| Readiness                                 | Honest `unauthenticated` / `unavailable` when directory or IAM material is missing                                                        | Falling back silently to API-key mode                                                                    |

No core Chat/Work/Code path may require a specific IdP or cloud. A driver that
cannot represent the auth kind safely reports `incompatible` or blocks, matching 0005.

Out of scope here: a catalogued connector marketplace, installing or updating
provider runtimes, and any path that lets a plugin mint host credentials.

## Threat model delta

Relative to
[security-architecture-threat-model](security/security-architecture-threat-model.md)
and the credential rules in 0005 / 0054:

| ID  | Delta                                                              | Control                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | Directory OAuth refresh tokens are longer-lived than API keys      | Broker-only storage; no journal, logs, export, or renderer echo; revoke/rotate is a host-local admin act                                                                                                                     |
| E2  | IAM signing material could be copied into provider child processes | Prefer per-request broker resolve or scoped signer; refuse durable cloud keys in managed-process env unless the driver proves the runtime cannot separate auth storage (then `incompatible`)                                 |
| E3  | Enterprise auth could become a vendor-shaped host API              | All new kinds land in `@octant/provider-sdk` first; conformance harness covers them; no server import of a single-cloud SDK for identity                                                                                     |
| E4  | Confused-deputy: a thread or remote principal triggers cloud spend | Existing mode, Project, and approval gates stay in front; remote stays local-host-required for credential changes (0013)                                                                                                     |
| E5  | Mis-set registry endpoint talks to the wrong tenant                | Instance config carries expected tenant/audience; enterprise-auth `ProviderDriver.probe` validates observed binding and reports `incompatible` when it cannot; `ProviderObservedState` records the binding the probe checked |

No new trust boundary moves credentials into `apps/server` or the renderer.

## Start gate (parent Later item)

Implementation may leave Backlog only when:

1. A Proposed or Accepted ADR names the auth-kind vocabulary and which broker
   operations drivers may call, without superseding 0005's "Octant never stores
   provider-native OAuth tokens" rule for CLI subscription flows that stay
   provider-owned.
2. Conformance harness cases exist for the new kinds (ready, unauthenticated,
   incompatible), including tenant/audience mismatch → `incompatible`.
3. Threat model controls E1–E5 have owners in an implementation child.
4. An explicit maintainer request authorizes scoped work against that ADR.

Until then the Later roadmap line for provider identity extensions remains a
hold.
