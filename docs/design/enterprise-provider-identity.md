# Enterprise provider identity

This topic specification owns how a model endpoint authenticates with an
enterprise directory sign-in (OAuth/OIDC against an organization's tenant) or a
cloud identity (cloud-IAM request signing), instead of an API key or a provider
runtime's own login. Architecture owns the boundary: the credential broker, the
provider SDK seam, and who may change credentials
([Architecture: providers](../architecture.md#providers) and
[security and authority](../architecture.md#security-and-authority)).
[Providers and model endpoints](model-endpoints.md) owns the Settings rows and
Add endpoint flow.

Status: authorized post-preview scope, and its decisions accepted by the
maintainer, on 2026-10-26. Slice 1a (the seam and its conformance) is built;
slices 1b and 1c are next. Nothing here changes what ships today: no broker
dialect or driver speaks `directory-oauth` yet, and an instance configured
with it reads `incompatible`. Each slice below lands with its own
implementation, tests, and the edits to this file that record what it built.

## Outcome

A person in an organization signs a model endpoint in with their work identity,
or lets the host sign requests with a cloud identity, and the endpoint runs on
the Octant Harness like any other direct endpoint. Reusable identity material
stays in the credential broker; a provider child process never receives it; the
server sees at most one short-lived, audience-bound credential for one request.
A missing, expired, revoked, or mis-bound identity reads honestly in readiness
and never falls back to another authentication.

## What exists today

| Piece                     | Where                                                                                                                                                                                                                                                       | What it gives this design                                                                                                                                                                                                                                                                   |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Credential broker         | [`credentialBroker.ts`](../../packages/host-runtime/src/credentialBroker.ts)                                                                                                                                                                                | Loopback service with a closed route set and a bearer token; the server reaches it only through `OCTANT_CREDENTIAL_BROKER_*`, which every child environment loses                                                                                                                           |
| Host OAuth runner         | [`hostOAuth.ts`](../../packages/host-runtime/src/hostOAuth.ts)                                                                                                                                                                                              | Descriptor-driven PKCE and device-code flows, single-flight refresh with rotation safety, typed sign-in-again, JWKS-validated identity tokens (ChatGPT plan dialect), issuer revocation; `/v1/credentials/resolve` refuses grant material (`isHostOAuthGrantMaterial`)                      |
| `subscription-oauth` kind | [`subscriptionOAuth.ts`](../../packages/provider-sdk/src/subscriptionOAuth.ts), [`directEndpointSubscriptionOAuth.ts`](../../apps/server/src/providers/directEndpointSubscriptionOAuth.ts)                                                                  | A credential pointer (`credentialRef`, `descriptorId`, `accountLabel`), per-request `access`/`refresh` through the host, origin re-check before any bearer is released, readiness mapping, and a conformance runner that never reports the token                                            |
| Harness endpoint port     | [`harnessEndpoint.ts`](../../packages/provider-sdk/src/harnessEndpoint.ts), [`harnessEndpointConformance.ts`](../../packages/provider-sdk/src/harnessEndpointConformance.ts)                                                                                | The seam a direct endpoint now uses: a driver supplies `open`/`send` and `admitTurn`; the host owns the loop, journal, retries, and registry. Ollama, OpenAI-compatible, Anthropic-compatible, and Azure AI Foundry drivers run on it ([Native harness](../architecture.md#native-harness)) |
| Azure AI Foundry driver   | [`azureFoundryDriver.ts`](../../apps/server/src/providers/azureFoundryDriver.ts), `AzureFoundryProviderConfiguration` in [`providers.ts`](../../packages/contracts/src/providers.ts)                                                                        | `authentication: "api-key"` only, sent in the `api-key` header                                                                                                                                                                                                                              |
| Bedrock through API keys  | [`bedrockMantleSmoke.integration.test.ts`](../../apps/server/src/providers/bedrockMantleSmoke.integration.test.ts), [`codexProcess.ts`](../../apps/server/src/providers/codexProcess.ts)                                                                    | Bedrock's OpenAI-compatible endpoint works as an ordinary `openai-compatible` instance with a Bedrock API key. Codex's own Bedrock provider reads the person's AWS profile in its delegated posture; static `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` never cross into it                 |
| `directory-oauth` seam    | [`directoryOAuth.ts`](../../packages/provider-sdk/src/directoryOAuth.ts), [`directoryOAuthConformance.ts`](../../packages/provider-sdk/src/directoryOAuthConformance.ts), `DirectoryBinding` in [`providers.ts`](../../packages/contracts/src/providers.ts) | Slice 1a: the pointer, `DirectoryOAuthHost`, per-request resolve with the binding checks, the one-renewal 401 rule, fixed failure sentences, and `runDirectoryOAuthConformance` against an in-memory fake directory and endpoint                                                            |
| Secret absence            | [`directProviderSecretAbsence.test.ts`](../../apps/server/src/providers/directProviderSecretAbsence.test.ts)                                                                                                                                                | The pattern for proving a credential reaches no event, failure, diagnostic, or journal record                                                                                                                                                                                               |

Nothing today signs in to a directory tenant or signs a cloud request.

## Decisions already settled

These follow from current specifications and are not reopened here:

- Credentials live in the host credential broker as opaque references; the
  renderer, journal, logs, exports, diagnostics, and plugins never receive raw
  material, and broker coordinates are stripped from every child
  ([Credentials](../architecture.md#providers)).
- A remote principal cannot start a sign-in, acknowledge terms, refresh, sign
  out, or change broker material; it may run turns on an instance that is
  already signed in, under the same mode, Project, and approval gates as an
  API-key instance ([host-driven provider sign-in](../architecture.md#security-and-authority)).
- `delegated-oauth` (a runtime's own login) is untouched: Octant never reads,
  stores, or injects those tokens. This design adds host-driven kinds only.
- Providers report readiness honestly and fail closed; an unrepresentable kind
  is `incompatible`; an API-key path stays available beside every sign-in.
- New kinds are provider-neutral vocabulary in `@octant/provider-sdk`; a driver
  reaches the broker through the same port a third-party driver could; no
  vendor identity SDK is imported into `apps/server`.
- Project provider policy (`eu-zdr` data tags) applies to these instances
  exactly as to any other.

## Authentication vocabulary

Endpoint configuration keeps `none`, `bearer`, `api-key`, `delegated-oauth`
(runtime-owned), and `subscription-oauth` (host-driven consumer sign-in). It
gains two host-driven kinds:

| Kind              | What the broker holds (never leaves it)                                                                 | What a driver may receive, per request                                                            | Readiness when it fails                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `directory-oauth` | The refresh token, the identity token's validated claims, the client and tenant binding                 | One access token whose audience is the model API's resource, with its expiry                      | `unauthenticated` (`missing`, `expired`, `revoked`, `interaction-required`, `not-authorized`); `unavailable` (broker or IdP unreachable); `incompatible` (binding) |
| `cloud-iam`       | The source identity (a cloud single-sign-on session) and the temporary cloud credentials minted from it | Signature headers for one request, computed by the broker; never a key, secret, or reusable token | Same set; a signing scope the request falls outside is `incompatible`                                                                                              |

`directory-oauth` is for an endpoint that accepts a bearer the organization's
directory issues for that endpoint's resource. `cloud-iam` is for an endpoint
that authorizes each request by a cloud signature, or whose only bearer would
be valid across the whole cloud account (see the Vertex decision below).

**Material classes.** Every value is one of two classes, and the class, not the
kind, decides where it may go:

- **Reusable identity material**: refresh tokens, directory sessions, client
  secrets or certificates, cloud access keys and secret keys, single-sign-on
  tokens, temporary cloud credentials, and any bearer valid beyond the model
  API. It lives only in the broker. It never reaches `apps/server`, a provider
  child process, the renderer, the journal, logs, diagnostics, or an export.
- **Request credential**: an access token whose audience is the model API's
  resource and whose lifetime is bounded by the issuer, or a signature bound to
  one request. The server's driver may hold it for that request only. It never
  enters a child process's environment, arguments, files, or a tool result;
  harness endpoints run in the server process, so no child exists to receive it.
  It joins the turn's resolved credential values, so `journal-lookup` and fork
  copies redact it as they redact an API key.

A provider runtime that spawns a child (Claude, Codex, OpenCode, ACP, Pi)
receives neither class from these kinds. Such a runtime reports the kinds
`incompatible` until an approved relay design exists (decision 6).

## Broker operations

`directory-oauth` reuses the host OAuth runner and its routes; it adds a
dialect and a binding, not a second store or a second refresh path.
`cloud-iam` adds one route family because signing is a different operation.

| Route                                      | Caller                                    | Directory change                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------ | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/v1/oauth/begin`                          | Server, for a local principal             | Dialect `directory-oidc`. The descriptor carries a tenant id (a GUID, never `common` or `organizations`), a client id, and an audience from a closed list; the broker builds the authority URLs from a closed issuer host, so configuration cannot name an arbitrary IdP                                                                                                                                   |
| `/v1/oauth/status`                         | Server                                    | Unchanged; on success the grant records the validated tenant, client, audience, the endpoint origin it was signed in for, and an account label                                                                                                                                                                                                                                                             |
| `/v1/oauth/access`                         | Server driver, per request                | Takes a required `binding` (tenant, client, audience, endpoint origin) for a directory grant and refuses (`binding-mismatch`) when it differs from the grant; returns the access token and expiry only                                                                                                                                                                                                     |
| `/v1/oauth/refresh`                        | Server driver, when access is near expiry | Unchanged single-flight refresh; directory error codes map to sign-in-again reasons                                                                                                                                                                                                                                                                                                                        |
| `/v1/oauth/revoke`                         | Server, for a local principal             | Deletes the local grant. The directory offers no client-side refresh-token revocation, so sign-out is local and Settings says so                                                                                                                                                                                                                                                                           |
| `/v1/credentials/resolve`                  | —                                         | Refuses directory and cloud grant material, as it already refuses subscription grants                                                                                                                                                                                                                                                                                                                      |
| `/v1/cloud-iam/{begin,status,sign,revoke}` | Server                                    | Later slice. `sign` takes a credential ref and the structured request: method, host, path, query, the headers to sign, and a payload hash. The broker checks each field against the binding it stored at sign-in (partition, region, service, host, path prefix, method), builds the canonical request itself, and returns headers; it never signs a caller-supplied digest. No route returns key material |

The server-side client grows the binding argument and nothing else; drivers
see a provider-sdk port, `DirectoryOAuthHost`, shaped like
`SubscriptionOAuthHost` with the binding on `access`. Its `sign-in-again`
reasons add `interaction-required`, and `access` adds `binding-mismatch`. A
grant the broker no longer holds reads `sign-in-again` (`expired`), as a
subscription grant does.

## Tenant, audience, and endpoint binding

A `directory-oauth` instance records three facts in its configuration, none
secret: the tenant id, the client id (as `directory: { tenantId, clientId }`),
and the endpoint's base URL. The audience is not configurable: each driver kind
names the one resource its endpoint accepts. The binding is checked at four
points, and each failure is `incompatible` without a model request:

1. **Sign-in.** The broker requests only the kind's audience and validates the
   identity token against the tenant's published keys: signature, issuer
   (`…/{tenantId}/v2.0`), audience (the client id), `tid` equal to the
   configured tenant, expiry, and nonce. It never parses the access token,
   which the directory treats as opaque to clients; the tenant-specific
   authority and the echoed scope bind it instead.
2. **Configuration change.** Editing the tenant, client id, or base URL origin
   of a signed-in instance drops the grant's usability until the person signs in
   again; the old grant is deleted, not rebound.
3. **Each request.** The driver compares the pointer with the configuration and
   the base URL with the grant's origin (as `resolveSubscriptionOAuthBearer`
   does today) before asking the broker, and the broker re-checks the binding
   before releasing a token.
4. **Probe.** The authenticated probe lists deployments. A tenant mismatch the
   endpoint reports through its closed set of error codes is `incompatible`;
   any other 401 or 403 is `unauthenticated` (`not-authorized` for a missing
   role assignment), with a fixed Octant sentence naming the role to request.
   `ProviderObservedState` records the binding the probe checked.

Endpoint hosts are a closed suffix list per kind, so a typo or a crafted
address cannot send a directory bearer elsewhere.

Rules slice 1a resolved, each the stricter reading of the text above:

- **GUID form.** Tenant and client ids are lowercase GUIDs, compared exactly.
  The contract refuses `common`, `organizations`, `consumers`, a domain name,
  and an uppercase GUID, so two spellings of one tenant can never disagree at
  a binding check; Settings lowercases what the person pastes (slice 1c).
- **Client id in the binding.** `access` carries the client id beside tenant,
  audience, and origin, because editing the client id must also drop the
  grant's usability (point 2).
- **No fallback.** A stored credential that is not a well-formed
  `directory-oauth` pointer, such as an API key left from an earlier
  configuration, reads `unauthenticated` (`missing`); the driver never sends
  it. A pointer with an unknown field, a non-https or path-bearing origin, or
  an audience with a query is not read at all.
- **Host list form.** A suffix starts with a dot and matches only a subdomain;
  the base URL must be https without embedded credentials.
- **Until the driver exists.** The Azure AI Foundry driver refuses to build
  for a `directory-oauth` configuration, so the instance reads `incompatible`
  and no stored key is sent in place of the sign-in. Slice 1c replaces the
  refusal with the directory transport.

## Expiry, refresh, and revocation

- **Per-request resolution.** The bearer is resolved for each `send`, never once
  per `open`: a harness session outlives a token. The port's `open` resolves the
  endpoint and keeps the pointer; slice 1 corrects its doc comment to say so.
  The existing 15-second skew applies.
- **Refresh.** Single-flight in the broker. Expired or revoked refresh grants,
  a password reset, or an administrator's session revocation become
  sign-in-again (`expired` or `revoked`) and drop the stored grant. A policy
  that needs the person present again (multi-factor or a conditional access
  prompt) is `interaction-required`. Network failures and 5xx answers are
  transient and read `unavailable`; they never drop the grant.
- **Mid-turn expiry.** A 401 on a send after a usable token makes the
  transport force one refresh and resend once inside that attempt; renewing a
  credential is the transport's own business, while the port's one-attempt rule
  governs outage retries. A second 401 fails the turn as `unauthenticated`
  (`revoked`), which the host does not retry as an outage: the endpoint refused
  a token the directory had just issued, so only a new sign-in can change the
  answer. The driver keeps no grant state, so the broker's grant stays as it
  was.
- **Revocation.** Sign out deletes the local grant; removing the instance and
  the host credential purge do the same. An administrator's revocation reaches
  Octant at the next refresh, so an issued access token can stay valid at the
  directory until its own expiry (about an hour). Octant keeps no token past a
  request, so the residual exposure is a token in flight. Continuous access
  evaluation is not requested in slice 1 (decision 3).

## Threat model

Relative to the
[security architecture threat model](../security/security-architecture-threat-model.md)
and its consumer sign-in delta (O1–O5):

| ID  | Threat                                                                 | Control                                                                                                                                                                                                                                                                                                               | Owner slice |
| --- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| E1  | A directory refresh token is longer-lived than an API key              | Broker-only storage; never journaled, logged, exported, or renderer-visible; local sign-out deletes it and Settings says the directory session is not revoked; residual risk is a valid refresh token until the directory invalidates it                                                                              | 1           |
| E2  | Reusable identity material reaches a provider child                    | Material classes above; harness endpoints have no child; spawning runtimes report the kinds `incompatible`; broker coordinates stay stripped; a conformance case proves a child environment carries neither class                                                                                                     | 1, 4        |
| E3  | Enterprise identity becomes a vendor-shaped host API                   | Kinds and ports in `@octant/provider-sdk`; the directory dialect is descriptor data; request signing is implemented from the documented algorithm with the platform's crypto, not a cloud SDK                                                                                                                         | 1, 4        |
| E4  | A thread or remote principal spends on the organization's account      | Mode, Project, and approval gates stay in front; remote principals cannot sign in, out, or rotate material                                                                                                                                                                                                            | 1           |
| E5  | A mis-set instance talks to the wrong tenant or host                   | Four-point binding above; GUID tenant only; closed audience and endpoint host lists                                                                                                                                                                                                                                   | 1           |
| E6  | A compromised server uses the signer as a general cloud oracle         | `sign` receives request fields, not a digest; the broker checks method, host, and path against the binding it stored (service, region, host, path prefix, method), builds the canonical request itself, and refuses everything else, so an allowed binding cannot cover another request; the server never holds a key | 4           |
| E7  | A bearer leaks through an error, diagnostic, fork, or `journal-lookup` | Fixed Octant sentences for every failure; the bearer joins the turn's redacted credential values; secret-absence tests extend to the new kinds                                                                                                                                                                        | 1           |
| E8  | Consent phishing or a look-alike sign-in page                          | The broker builds authority URLs from a closed issuer host and the tenant GUID; PKCE with one-shot loopback redirect and state; device code is opt-in per instance (decision 2)                                                                                                                                       | 1, 2        |

## Conformance cases

A provider-sdk `runDirectoryOAuthConformance` (and later
`runCloudIamConformance`) proves these against a fake directory and a fake
endpoint, reporting outcomes and never the token. Every direct-endpoint driver
that declares the kind also passes `runHarnessEndpointConformance`.

The runner proves the driver-facing rows: a driver supplies its audience, two
base URLs on its host list, and a factory that builds it against the runner's
fake broker, endpoint, and clock. The fake broker keeps the real broker's
rules (binding re-check, single-flight refresh, which refusals drop the
grant), so "grant kept" is proved by the driver recovering without a new
sign-in and "grant dropped" by its staying unauthenticated. The raw-resolve and
remote-principal rows concern the broker and the server, not a driver; slice
1b proves them against the broker.

| Case                                                                                                      | Expected                                                                       |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Valid grant and binding                                                                                   | `ready`; the endpoint sees a bearer; capabilities claimed only after the probe |
| No grant                                                                                                  | `unauthenticated` (`missing`); the broker and endpoint are not called          |
| Access token near expiry, refresh succeeds                                                                | `ready`; one refresh even under concurrent resolves                            |
| Refresh refused as expired, revoked, or reused                                                            | `unauthenticated` with that reason; grant dropped                              |
| Refresh needs the person present                                                                          | `unauthenticated` (`interaction-required`); grant kept                         |
| Broker or directory unreachable, or a 5xx                                                                 | `unavailable`; grant kept                                                      |
| Pointer tenant or audience differs from configuration                                                     | `incompatible`; the broker is not asked                                        |
| Base URL origin differs from the grant, or is off the list                                                | `incompatible`; the broker is not asked                                        |
| Endpoint answers 403 for a missing role                                                                   | `unauthenticated` (`not-authorized`)                                           |
| 401 mid-session after a usable token                                                                      | one forced refresh and resend; a second 401 fails `unauthenticated`            |
| Raw `/v1/credentials/resolve` on the grant                                                                | refused                                                                        |
| Remote principal begins, refreshes, or signs out                                                          | refused                                                                        |
| Any report, failure, event, diagnostic, or journal record                                                 | contains no token                                                              |
| (`cloud-iam`) Sign request outside the binding                                                            | refused; no signature produced                                                 |
| (`cloud-iam`) Sign request that carries a precomputed digest or its own binding                           | refused; no signature produced                                                 |
| (`cloud-iam`) Signed request replayed with a changed method, host, path, query, signed header, or payload | the signature does not verify at the fake endpoint                             |
| (`cloud-iam`) Child environment of any spawning runtime                                                   | carries no source identity, temporary credential, or signature                 |

## Maintainer decisions

The maintainer accepted these on 2026-10-26. Each states the rule; the
alternatives considered and the reason for the choice follow it. Slice 1
depends only on 1–3.

1. **Directory client registration.** The organization registers a public
   client in its own tenant and enters its client id beside the tenant id. This
   needs no Octant account and no third-party contact, and the tenant
   administrator controls consent. Deferred: an Octant-published, verified
   multi-tenant client that tenants consent to; it needs a separate maintainer
   action (creating and verifying a publisher registration). Reusing another
   product's first-party client id is refused under the originality rule.
2. **Sign-in flow.** The desktop signs in with the authorization code flow and
   PKCE on a loopback redirect only. Device code is a per-instance opt-in for a
   host without the desktop app, in a later slice (slice 2), never the default:
   many tenants block it by policy, and it is the easier flow to phish.
3. **Continuous access evaluation.** Octant does not request it, keeping
   ordinary hour-long tokens and no claims challenges. Rejected for slice 1:
   requesting it and handling claims challenges as `interaction-required`.
   Revisit when a tenant requires it.
4. **First cloud-IAM source identity.** The cloud's single-sign-on device
   authorization, held in the broker. Rejected: long-lived access keys stored
   in the broker, which are reusable identity material the broker would hold
   indefinitely and which the existing Bedrock API-key path already covers as
   static credentials; and reading the person's cloud profile files, which
   makes Octant read another tool's credential store.
5. **Google Vertex.** Deferred until an organization needs it. Its bearer is
   valid across the whole cloud account, so it may never reach the server;
   when it is built, the only acceptable shape is a broker-side relay that
   attaches the token and forwards only to the bound host.
6. **Spawning runtimes on enterprise identity.** Not supported in this
   workstream: those runtimes keep their own delegated login. Rejected for now:
   a host loopback relay that a child calls with a per-session capability
   useless outside the host. It needs its own design, because the child can
   still spend through the relay for the session.

## Delivery slices

Each slice is reviewable alone and targets `main` unless it says it stacks.

**Slice 1: Microsoft Entra ID sign-in for Azure AI Foundry.** A native stack of
three layers:

- **1a. Seam and conformance.** Built. `directory-oauth` in contracts
  (`AzureFoundryAuthentication` gains it; the configuration gains the tenant and
  client ids) and in provider-sdk (`DirectoryOAuthHost`, the pointer, resolve,
  readiness, `runDirectoryOAuthConformance`); the port's `open` doc comment says
  credentials resolve per send. _Acceptance:_ every conformance case for
  `directory-oauth` passes against fakes. _Verification:_ focused provider-sdk
  and contract tests, typecheck of consumers. _Evidence:_ a reference driver
  written only against the seam passes every driver-facing case, and drivers
  that bind to the pointer instead of their configuration, give up on a 401,
  or echo the bearer in a failure each fail the runner; the contract refuses
  multi-tenant aliases and secrets; the Foundry driver refuses a
  `directory-oauth` configuration until 1c.
- **1b. Broker dialect.** `directory-oidc` in the host OAuth runner: closed
  issuer host, tenant-specific authority, identity-token validation, binding on
  `access`, error-code mapping, local revoke. _Acceptance:_ a fake directory
  drives sign-in, refresh, every sign-in-again reason, and binding refusal;
  raw resolve refuses the grant; remote negatives refuse. _Verification:_
  host-runtime tests.
- **1c. Foundry driver and Settings.** The Foundry driver, already on the
  harness endpoint port, sends the bearer per request, probes with it, and
  redacts it; Add endpoint offers Sign in beside the key with tenant and client
  id fields; [Providers and model endpoints](model-endpoints.md), architecture,
  and the user guide are updated. _Acceptance:_ a Foundry instance signed in
  against fakes runs a Chat, Work, and Code turn; readiness states render;
  secret-absence passes. _Verification:_ server tests, web component test,
  rendered QA of the Settings states.
- **Needs the maintainer:** a real-tenant smoke (an Entra tenant, an app
  registration, a Foundry resource with a role assignment; billed). Until it
  runs it is a named blocker on closing slice 1, not on reviewing it.

Why Foundry with Entra first: its driver and Settings already exist, so the
slice is authentication only; the token is a bearer whose audience is the model
resource, so it fits the request-credential class with no broker relay or
signer; the host OAuth runner already does PKCE, refresh, and identity-token
validation; and the tenant binding is explicit in the identity token. Bedrock
needs a new wire transport and a signer, and Vertex needs a relay, so either
would be several slices before the first sign-in.

**Slice 2: device-code sign-in for hosts without the desktop app**
(decision 2). `octant provider sign-in` on the host, opt-in per instance.
_Acceptance:_ a headless host signs in with device code against a fake
directory; remote principals cannot start it. Linux container capable.

**Slice 3: directory sign-in for OpenAI-compatible and Anthropic-compatible
gateways.** A generic OIDC directory dialect for an organization's own model
gateway, with the issuer host fixed per instance at creation. _Acceptance:_ the
conformance cases pass for both drivers. Linux container capable; a real
gateway smoke needs the maintainer.

**Slice 4: cloud-IAM signer and Amazon Bedrock.** `/v1/cloud-iam/*`, the
single-sign-on source identity (decision 4), request signing in host-runtime,
and a Bedrock transport on the harness endpoint port. _Acceptance:_ the
`cloud-iam` conformance cases pass; a request outside the binding is refused;
the broker builds every canonical request from request fields; the server
process never holds a key. Linux container capable against fakes;
a real smoke needs an AWS organization and billed Bedrock access.

**Later, each needing its own maintainer decision:** Google Vertex through a broker relay (decision 5);
spawning runtimes on enterprise identity (decision 6); an Octant-published
directory client (decision 1b).

## Verification

Prose alone needs no test. Each slice's evidence is its conformance run, its
permission negatives (remote principal, raw resolve, child environment), the
secret-absence suite, and, for closure, the real-account smoke named above.
