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
maintainer, on 2026-10-26. Slice 1 is built: 1a (the seam and its
conformance), 1b (the broker's `directory-oidc` dialect), and 1c (the Azure AI
Foundry driver, Settings, and user guide). An Azure AI Foundry endpoint can
sign in with the organization's Microsoft Entra ID account against fakes;
closing slice 1 waits only on the maintainer's real-tenant smoke below. Slice
2 is built: a host without the desktop app signs an opted-in instance in with
a device code from `octant provider sign-in`, against fakes; closing it waits
on its own real-tenant smoke. Slice 3 is built: an OpenAI-compatible or
Anthropic-compatible gateway can sign in at the organization's own OpenID
Connect issuer (the broker's `issuer-oidc` dialect) against fakes; closing it
waits only on the maintainer's real-gateway smoke below. Slice 4 is built: an
Amazon Bedrock endpoint signs in at the organization's single sign-on portal
with a device code, and the broker signs each Converse request (`cloud-iam`),
against fakes; closing it waits only on the maintainer's real-account smoke
below. Settings adds an Amazon Bedrock endpoint, lists it under Model
endpoints, and signs it out; its sign-in still begins only in the host's
terminal.
Each slice below lands with its own implementation, tests, and the edits to
this file that record what it built.

## Outcome

A person in an organization signs a model endpoint in with their work identity,
or lets the host sign requests with a cloud identity, and the endpoint runs on
the Octant Harness like any other direct endpoint. Reusable identity material
stays in the credential broker; a provider child process never receives it; the
server sees at most one short-lived, audience-bound credential for one request.
A missing, expired, revoked, or mis-bound identity reads honestly in readiness
and never falls back to another authentication.

## What exists today

| Piece                     | Where                                                                                                                                                                                                                                                                                                                                                                | What it gives this design                                                                                                                                                                                                                                                                   |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Credential broker         | [`credentialBroker.ts`](../../packages/host-runtime/src/credentialBroker.ts)                                                                                                                                                                                                                                                                                         | Loopback service with a closed route set and a bearer token; the server reaches it only through `OCTANT_CREDENTIAL_BROKER_*`, which every child environment loses                                                                                                                           |
| Host OAuth runner         | [`hostOAuth.ts`](../../packages/host-runtime/src/hostOAuth.ts)                                                                                                                                                                                                                                                                                                       | Descriptor-driven PKCE and device-code flows, single-flight refresh with rotation safety, typed sign-in-again, JWKS-validated identity tokens (ChatGPT plan dialect), issuer revocation; `/v1/credentials/resolve` refuses grant material (`isHostOAuthGrantMaterial`)                      |
| `subscription-oauth` kind | [`subscriptionOAuth.ts`](../../packages/provider-sdk/src/subscriptionOAuth.ts), [`directEndpointSubscriptionOAuth.ts`](../../apps/server/src/providers/directEndpointSubscriptionOAuth.ts)                                                                                                                                                                           | A credential pointer (`credentialRef`, `descriptorId`, `accountLabel`), per-request `access`/`refresh` through the host, origin re-check before any bearer is released, readiness mapping, and a conformance runner that never reports the token                                            |
| Harness endpoint port     | [`harnessEndpoint.ts`](../../packages/provider-sdk/src/harnessEndpoint.ts), [`harnessEndpointConformance.ts`](../../packages/provider-sdk/src/harnessEndpointConformance.ts)                                                                                                                                                                                         | The seam a direct endpoint now uses: a driver supplies `open`/`send` and `admitTurn`; the host owns the loop, journal, retries, and registry. Ollama, OpenAI-compatible, Anthropic-compatible, and Azure AI Foundry drivers run on it ([Native harness](../architecture.md#native-harness)) |
| Azure AI Foundry driver   | [`azureFoundryDriver.ts`](../../apps/server/src/providers/azureFoundryDriver.ts), `AzureFoundryProviderConfiguration` in [`providers.ts`](../../packages/contracts/src/providers.ts)                                                                                                                                                                                 | `api-key` sent in the `api-key` header, or (slice 1c) `directory-oauth` through [`directEndpointDirectoryOAuth.ts`](../../apps/server/src/providers/directEndpointDirectoryOAuth.ts): a bearer resolved per request, the endpoint's error codes read, nothing stored ever sent              |
| Directory sign-in route   | [`providerDirectorySignIn.ts`](../../apps/server/src/providers/oauth/providerDirectorySignIn.ts), [`directoryOAuthHost.ts`](../../apps/server/src/providers/oauth/directoryOAuthHost.ts), [`directorySignIn.ts`](../../packages/domain/src/directorySignIn.ts)                                                                                                       | Slice 1c: begin, poll, status, and local sign-out on `/api/providers/oauth`, with the broker descriptor built from the instance's configuration; the broker port with the binding on `access`; the Foundry audience and host list as shared product data                                    |
| Bedrock through API keys  | [`bedrockMantleSmoke.integration.test.ts`](../../apps/server/src/providers/bedrockMantleSmoke.integration.test.ts), [`codexProcess.ts`](../../apps/server/src/providers/codexProcess.ts)                                                                                                                                                                             | Bedrock's OpenAI-compatible endpoint works as an ordinary `openai-compatible` instance with a Bedrock API key. Codex's own Bedrock provider reads the person's AWS profile in its delegated posture; static `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` never cross into it                 |
| `directory-oauth` seam    | [`directoryOAuth.ts`](../../packages/provider-sdk/src/directoryOAuth.ts), [`directoryOAuthConformance.ts`](../../packages/provider-sdk/src/directoryOAuthConformance.ts), `DirectoryBinding` in [`providers.ts`](../../packages/contracts/src/providers.ts)                                                                                                          | Slice 1a: the pointer, `DirectoryOAuthHost`, per-request resolve with the binding checks, the one-renewal 401 rule, fixed failure sentences, and `runDirectoryOAuthConformance` against an in-memory fake directory and endpoint                                                            |
| `directory-oidc` dialect  | [`hostOAuth.ts`](../../packages/host-runtime/src/hostOAuth.ts), [`fakeDirectory.test-support.ts`](../../packages/host-runtime/src/fakeDirectory.test-support.ts)                                                                                                                                                                                                     | Slice 1b: tenant-built authority, identity-token validation with `tid`, the echoed-scope binding, the binding check on `access`, directory error-code mapping, local sign-out, and an HTTP fake directory (authorize, token, key set) the broker tests drive                                |
| Device-code sign-in       | [`providerDeviceSignInRoutes.ts`](../../apps/server/src/providers/oauth/providerDeviceSignInRoutes.ts), [`providerSignInCommand.ts`](../../packages/cli/src/providerSignInCommand.ts)                                                                                                                                                                                | Slice 2: `octant provider sign-in <instance>` on the host, the host-local `/api/desktop/provider-sign-in` routes, the broker's directory device authorization, and the per-instance `deviceCodeSignIn` opt-in                                                                               |
| Gateway issuer sign-in    | [`hostOAuth.ts`](../../packages/host-runtime/src/hostOAuth.ts) (`issuer-oidc`), [`directorySignIn.ts`](../../packages/domain/src/directorySignIn.ts) (`gatewayDirectoryDescriptor`), `DirectoryIssuerBinding` in [`providers.ts`](../../packages/contracts/src/providers.ts), [`gatewayDirectory.test.ts`](../../apps/server/src/providers/gatewayDirectory.test.ts) | Slice 3: the organization's own issuer, found by its discovery document, for one gateway scope; the OpenAI-compatible and Anthropic-compatible drivers send its bearer per request on the same seam, transport, and route as Foundry                                                        |
| Cloud signer              | [`cloudIam.ts`](../../packages/host-runtime/src/cloudIam.ts), [`sigV4.ts`](../../packages/host-runtime/src/sigV4.ts), [`fakeCloudIam.test-support.ts`](../../packages/host-runtime/src/fakeCloudIam.test-support.ts)                                                                                                                                                 | Slice 4: the `/v1/cloud-iam/*` routes, the single sign-on device authorization, role credentials minted and renewed in the broker, the closed signing table, and Signature Version 4 checked against the cloud's published examples                                                         |
| `cloud-iam` seam          | [`cloudIam.ts`](../../packages/provider-sdk/src/cloudIam.ts), [`cloudIamConformance.ts`](../../packages/provider-sdk/src/cloudIamConformance.ts), `CloudIamSigningScope` in [`providers.ts`](../../packages/contracts/src/providers.ts)                                                                                                                              | Slice 4: the pointer, `CloudIamHost`, per-request signing with the configuration and scope checks, the one-renewal rule, fixed failure sentences, and `runCloudIamConformance` against an in-memory signer and endpoint                                                                     |
| Amazon Bedrock driver     | [`amazonBedrockDriver.ts`](../../apps/server/src/providers/amazonBedrockDriver.ts), [`bedrockConverse.ts`](../../apps/server/src/providers/bedrockConverse.ts), [`providerCloudIamSignIn.ts`](../../apps/server/src/providers/oauth/providerCloudIamSignIn.ts), [`cloudIamSignIn.ts`](../../packages/domain/src/cloudIamSignIn.ts)                                   | Slice 4: the Converse stream on the harness endpoint port, each request signed by the broker; the host-local sign-in; the signing scope as product data                                                                                                                                     |
| Secret absence            | [`directProviderSecretAbsence.test.ts`](../../apps/server/src/providers/directProviderSecretAbsence.test.ts), [`hostOAuthDirectorySecretAbsence.test.ts`](../../packages/host-runtime/src/hostOAuthDirectorySecretAbsence.test.ts)                                                                                                                                   | The pattern for proving a credential reaches no event, failure, diagnostic, or journal record; slice 1b applies it to every broker answer and the console for a directory grant                                                                                                             |

Only the broker signs a cloud request (slice 4), and only inside the scope its
grant was signed in for.

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
| `directory-oauth` | The refresh token, the identity token's validated claims, the client and tenant (or issuer) binding     | One access token whose audience is the model API's resource, with its expiry                      | `unauthenticated` (`missing`, `expired`, `revoked`, `interaction-required`, `not-authorized`); `unavailable` (broker or IdP unreachable); `incompatible` (binding) |
| `cloud-iam`       | The source identity (a cloud single-sign-on session) and the temporary cloud credentials minted from it | Signature headers for one request, computed by the broker; never a key, secret, or reusable token | Same set; a signing scope the request falls outside is `incompatible`                                                                                              |

`directory-oauth` is for an endpoint that accepts a bearer the organization's
directory issues for that endpoint's resource: a tenant of the closed directory
for a driver kind with one audience (Azure AI Foundry), or the organization's
own OpenID Connect issuer for its own gateway (slice 3). `cloud-iam` is for an endpoint
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
  It lives only in the headers of the one send that carries it, which no
  journal record, `journal-lookup` excerpt, or fork copy contains (slice 1c's
  rule below).

A provider runtime that spawns a child (Claude, Codex, OpenCode, ACP, Pi)
receives neither class from these kinds. Such a runtime reports the kinds
`incompatible` until an approved relay design exists (decision 6).

## Broker operations

`directory-oauth` reuses the host OAuth runner and its routes; it adds a
dialect and a binding, not a second store or a second refresh path.
`cloud-iam` adds one route family because signing is a different operation.

| Route                                      | Caller                                    | Directory change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/v1/oauth/begin`                          | Server, for a local principal             | Dialect `directory-oidc`. The descriptor carries a tenant id (a GUID, never `common` or `organizations`), a client id, and an audience from a closed list; the broker builds the authority URLs from a closed issuer host, so configuration cannot name an arbitrary IdP. The flow is the loopback PKCE redirect or (slice 2) a device code at the tenant's own device authorization URL. Dialect `issuer-oidc` (slice 3) names an organization's own issuer, fixed when the instance is created, a client, and one gateway scope; the broker reads the issuer's endpoints from its discovery document, on the issuer's own origin only, and signs in on the loopback redirect alone |
| `/v1/oauth/status`                         | Server                                    | Unchanged; on success the grant records the validated tenant, client, audience, the endpoint origin it was signed in for, and an account label                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `/v1/oauth/access`                         | Server driver, per request                | Takes a required `binding` (tenant, client, audience, endpoint origin; or issuer, client, scope, endpoint origin) for a directory grant and refuses (`binding-mismatch`) when it differs from the grant; returns the access token and expiry only                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `/v1/oauth/refresh`                        | Server driver, when access is near expiry | Unchanged single-flight refresh; directory error codes map to sign-in-again reasons                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `/v1/oauth/revoke`                         | Server, for a local principal             | Deletes the local grant. The directory offers no client-side refresh-token revocation, so sign-out is local and Settings says so                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `/v1/credentials/resolve`                  | —                                         | Refuses directory and cloud grant material, as it already refuses subscription grants                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `/v1/cloud-iam/{begin,status,sign,revoke}` | Server                                    | Slice 4. `sign` takes a credential ref and the structured request: method, host, path, query, the headers to sign, and a payload hash. The broker checks each field against the binding it stored at sign-in (partition, region, service, host, path prefix, method), builds the canonical request itself, and returns headers; it never signs a caller-supplied digest. No route returns key material                                                                                                                                                                                                                                                                               |

The server-side client grows the binding argument and nothing else; drivers
see a provider-sdk port, `DirectoryOAuthHost`, shaped like
`SubscriptionOAuthHost` with the binding on `access`. Its `sign-in-again`
reasons add `interaction-required`, and `access` adds `binding-mismatch`. A
grant the broker no longer holds reads `sign-in-again` (`expired`), as a
subscription grant does.

A settled sign-in attempt, of either route family, stays readable through
`status` for five minutes past its deadline (longer than the server follows
one) and is then forgotten when the next attempt begins, so abandoned
attempts do not accumulate in a long-running broker; a forgotten attempt
reads `unknown`. An attempt still waiting on the issuer is kept, since its
answer may yet store a grant that only that attempt names.

Every request the broker sends to an issuer or a portal, in either route
family, carries one deadline: discovery, device authorization, each
device-code poll, a code exchange, a refresh, a key set, role credentials,
and sign-out. An answer not complete 30 seconds after the request went out,
body included, is abandoned and read as no answer at all. A device-code poll
then waits and polls again with the outage backoff (slice 2's polling rule),
a refresh is transient and leaves the grant as it was for the next try,
beginning a sign-in is `unavailable`, and sign-out still deletes the local
grant. Without a bound, one hung poll kept its attempt awaiting consent past
its code's expiry, where neither expiry nor pruning could end it, and one
hung refresh would hold every send waiting on that grant's single-flight
renewal. Both route families take the bound from one place
([`issuerRequest.ts`](../../packages/host-runtime/src/issuerRequest.ts)), so
the rule cannot drift between them.

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
- **Until the driver existed.** Slices 1a and 1b refused to create or change
  an Azure AI Foundry instance to `directory-oauth`, and the driver refused to
  build for one read from storage, so no stored key was sent in place of the
  sign-in. Slice 1c replaced both refusals with the directory transport.

Rules slice 1b resolved in the broker, each the most conservative reading:

- **One issuer, one audience.** The closed issuer host is
  `login.microsoftonline.com`; sovereign clouds wait for an organization that
  needs one. The broker builds the tenant's authorize, token, and key-set URLs
  from it and fetches no discovery document. The closed audience list is
  `https://cognitiveservices.azure.com`, the resource Azure AI Foundry's
  OpenAI-compatible endpoints accept.
- **Descriptor shape.** A `directory-oidc` descriptor names the tenant, client,
  audience, and endpoint origin and nothing else: no URL and no scope (slice
  1b also refused the device flow, which slice 2 admits without a URL). The
  broker requests the audience's `.default` scope with `openid`, `profile`,
  and `offline_access`, and no other resource.
- **Callback code.** The directory's authorization codes are opaque and run
  past a thousand characters, so the directory callback accepts a code up to
  the 4,096-character query cap; the other dialects keep the 512-character
  limit.
- **Echoed scope.** Every resource scope the directory echoes must sit under
  the audience, and at least one must; the identity scopes, which the echo may
  omit, are ignored. A refresh whose echo leaves the audience ends the grant
  (`revoked`).
- **Identity token.** Sign-in checks `tid` beside the tenant-specific issuer.
  A refresh's new identity token must keep the tenant and subject or the grant
  ends; one the broker cannot check because the key set is unreachable keeps
  the rotated tokens and the prior identity, as the ChatGPT plan dialect does,
  since the directory may already have retired the previous refresh token. The
  grant keeps the subject and an account label (`preferred_username`, else
  `name`, when either is plain text), never the identity token. A key set may
  be up to 64 KiB because the directory publishes certificate chains.
- **Binding on `access`.** A directory grant releases its token only to a
  request naming its exact binding; a missing binding is `binding-mismatch`. A
  binding sent for a grant of any other kind is also `binding-mismatch`, so a
  caller expecting a directory grant never receives another kind's bearer. A
  binding that is not exactly the four text fields is a malformed request. The
  broker requires a canonical https origin and compares it exactly; the
  endpoint host list stays the driver's, because the server already holds each
  request's token and a second list in the broker would not narrow what a
  compromised server could do.
- **Refresh error codes.** The broker reads the directory's `error`,
  `suberror`, and numeric `error_codes`, never its description text.
  `interaction_required`, `login_required`, `consent_required`, the
  `basic_action`, `additional_action`, `message_only`, `user_password_expired`,
  and `consent_required` sub-errors, and AADSTS50076, 50079, 50158, and 65001
  are `interaction-required` and keep the grant. `invalid_grant` with the
  `token_expired` sub-error or AADSTS70008, 700082, or 70043 is `expired`; any
  other `invalid_grant` (including AADSTS50173, a password change or an
  administrator's revocation), `invalid_client`, and `unauthorized_client` are
  `revoked`. Both drop the grant. Every other answer, a 429 or 5xx, and a
  network failure are transient and keep it. The directory does not detect
  refresh-token reuse, so this dialect never reports `refresh-reused`.
- **Remote principals.** The broker answers only the server: a loopback peer
  carrying the launch token and no browser `Origin`. The server's principal
  gate refuses a remote begin, refresh, or sign-out before any broker call,
  for every dialect.
- **Left to 1c.** The binding argument on the server's broker client, the
  server contract's `interaction-required`, and how Settings shows the account
  label; slice 1c settled each (below).

Rules slice 3 resolved for an organization's own gateway, each the most
conservative reading of "a generic OIDC directory dialect, with the issuer host
fixed per instance at creation":

- **Dialect and binding.** The broker's `issuer-oidc` dialect; the credential
  kind stays `directory-oauth`. The binding is the issuer, the client, the one
  gateway scope, and the endpoint origin, in place of tenant and audience. A
  tenant binding never equals an issuer binding, the broker refuses a binding
  that mixes their fields as malformed, and a pointer naming both is not read.
- **Issuer form.** An https address with no credentials, query, fragment, or
  space, at most 256 characters, compared exactly with the identity token's
  `iss` (a trailing slash matters, so Settings trims it and nothing else).
- **Fixed at creation.** Provider policy refuses an update that changes a
  gateway's issuer, or that switches a gateway into or out of
  `directory-oauth`: adding an issuer later would set it after creation. The
  client, scope, and base URL may change; the server forgets the grant and
  deletes the pointer before the change is journaled. Reason: the issuer is
  where the person types their password, so whoever can edit an instance must
  not be able to point its next sign-in at another page.
- **Discovery.** The broker fetches the issuer's
  `/.well-known/openid-configuration` (no redirect, 64 KiB) before any
  listener opens. The document must name the issuer exactly and put its
  authorize, token, and key-set endpoints on the issuer's own https origin
  with no query; when it lists PKCE methods, S256 must be one. Anything else
  is `invalid`; an unreachable issuer, a 429, or a 5xx is `unavailable`. The
  grant keeps the token endpoint and key-set address, so a refresh does not
  discover again. Rejected: endpoints named in configuration, which would make
  the token exchange's host a free field.
- **One resource scope.** Each gateway names exactly one RFC 6749 scope token
  that is not an identity scope; the broker requests it with `openid`,
  `profile`, and `offline_access` and sends no RFC 8707 `resource`, which some
  issuers refuse. Every resource scope the issuer echoes must be that scope
  (or sit under its resource when it asks for `.default`), and at least one
  must: an echo that omits the scope is refused, although RFC 6749 lets an
  issuer leave it out, because the token's resource could not then be told. A
  gateway needing two scopes waits for an organization that needs one.
- **Identity token.** Validated against the discovered key set: RS256
  signature, issuer, audience (the client), expiry, and nonce; there is no
  `tid`. The client id is letters, digits, `.`, `_`, `~`, or `-`, at most 128.
- **Refresh error codes.** Standard codes only: `interaction_required`,
  `login_required`, and `consent_required` are `interaction-required` and keep
  the grant; `invalid_grant`, `invalid_client`, and `unauthorized_client` are
  `revoked` and drop it, since a generic issuer does not say whether a grant
  expired or was withdrawn; everything else is transient. The description is
  never read.
- **No host list.** A gateway lives on the organization's own host, so the
  binding's origin, fixed at sign-in, is the only place its bearer goes. The
  base URL must be https without credentials, including on loopback, where a
  keyed endpoint may use http.
- **Gateway answers.** The transport reads only the status, never the body: a
  401 renews the token once and resends once, and a 403 is `not-authorized`.
  The Foundry error codes are not read for a gateway.
- **Settings and route.** Add endpoint offers the organization account only
  for an address the person brings, not a preset. The sign-in uses the
  descriptor id `gateway-directory` and terms `gateway-directory-1`; a command
  naming another kind's descriptor for an instance is refused, and a catalog
  subscription sign-in is refused for an instance that signs in with its
  organization, since its pointer would replace the organization pointer and
  orphan the grant.
- **Failure sentence.** The `incompatible` sentence names the endpoint's
  "directory, client, or address", so it reads true for a tenant or an issuer.
- **No device code.** Slice 2's device-code sign-in stays Azure AI Foundry's
  opt-in: a gateway's configuration has no `deviceCodeSignIn` field, the
  contract and the broker refuse an `issuer-oidc` descriptor with the
  device-code flow, and `octant provider sign-in` refuses a gateway as not
  allowing a device code, before any broker call. Reason: slice 2's rules
  (closed verification-page list, the tenant's own device authorization URL)
  are written for the closed directory; a generic issuer's would need its own
  rules and a maintainer decision.

Rules slice 1c resolved, each the most conservative reading:

- **Request credential.** A directory bearer lives only in the headers of the
  one send that carries it. It does not join the turn's resolved credential
  values (an API key does not either: those values are a Code root's own
  secrets), because no transcript, `journal-lookup` excerpt, or fork copy
  records request headers. The secret-absence suite proves the journal's
  stored bytes, a lookup, a fork copy, events, readiness, and failures carry
  none of the issued tokens, even when the endpoint echoes the bearer in an
  error body.
- **Endpoint answers.** The transport reads only a refusal's `error.code`,
  within 16 KiB. A 401 or 403 whose code is `InvalidAuthenticationTokenTenant`
  is `incompatible`; `PermissionDenied`, which Azure AI Foundry sends as a 401
  for a signed-in account without a data-plane role, is `not-authorized` and is
  not renewed; any other 401 renews the token once and resends once; any other
  403 is `not-authorized`. The real-tenant smoke confirms these codes.
- **Foundry audience and hosts.** The audience is
  `https://cognitiveservices.azure.com`; the host list is `.openai.azure.com`,
  `.services.ai.azure.com`, and `.cognitiveservices.azure.com`
  ([`directorySignIn.ts`](../../packages/domain/src/directorySignIn.ts)).
  Provider policy refuses a `directory-oauth` instance off that list, or with a
  tenant or client that is not a lowercase GUID, when it is created or changed.
- **Beginning a sign-in.** Settings begins one through the existing
  `/api/providers/oauth` route under the descriptor id
  `azure-foundry-directory`. The server builds the broker descriptor from the
  instance's configuration on every command and never from the request, and
  refuses an instance that does not sign in with its directory or whose
  address is off the host list. The panel's consent line (terms id
  `azure-foundry-directory-1`) says what the sign-in does and that signing out
  does not end the organization session; it is acknowledged once per host, as
  a subscription sign-in's terms are.
- **Account label.** The broker's `signed-in` status carries the directory
  account label it already validated (directory dialect only); the server keeps
  it in the instance's pointer, and the route's status answer gives it to
  Settings ("Signed in as"). Without one the label is "Organization account".
- **Kept `interaction-required` grants.** Status keeps the pointer and answers
  `expired` with the reason, and readiness reads `unauthenticated`
  (`interaction-required`) with `credentialStatus` `stored`. A new sign-in does
  not renew the kept grant: it makes a new one, and the server forgets the
  kept grant before it stores the new pointer. A grant the broker cannot forget
  at that moment is left to it, and the new sign-in stands. Sign-out forgets
  the grant and answers `signed-out-locally`.
- **Switching how an instance signs in.** Switching an Azure AI Foundry
  instance between `api-key` and `directory-oauth`, or changing its tenant,
  client, or base URL, deletes the stored credential and forgets a pointer's
  grant before the change is journaled, and refuses the change when either
  cannot be done. Removing a `directory-oauth` instance forgets its grant
  first. The key path also refuses a stored value that reads as a directory
  pointer, so a pointer is never sent as a key and a key is never read as one.
- **Readiness.** `ProviderObservedState` gains `unauthenticatedReason` (the
  provider-sdk reasons) and `directoryBinding` (the tenant, client, and origin
  the probe checked). A refused probe claims no models or capabilities.
- **Server contract.** `HostOAuthSignInAgainReason` gains
  `interaction-required`, and `HostOAuthDescriptor` gains the
  `directory-oidc` dialect with its tenant, audience, and endpoint origin and
  no URL or scope. The subscription and MCP sign-ins never receive that reason;
  were they to, it reads `unavailable` and `expired` respectively.
- **An instance changed mid-sign-in.** The pointer is stored for the binding
  the instance holds when the sign-in finishes; if the grant was begun for
  another, the broker refuses it at the first request (`incompatible`).

Rules slice 2 resolved, each the most conservative reading of decision 2:

- **The opt-in.** A `directory-oauth` Azure AI Foundry configuration carries
  `deviceCodeSignIn: true` when the person turned the sign-in on; absent is
  off, the contract refuses `false` so off has one spelling, and provider
  policy refuses the opt-in on an API-key instance. Settings shows it as
  "Allow sign-in with a code from this host's terminal" under Name and
  address, off by default. It is not part of the binding: turning it on or off
  keeps the grant, because it governs how a sign-in begins and a grant is the
  same whichever flow made it. Sign out ends a grant.
- **Where a device code begins.** Only the host-local
  `/api/desktop/provider-sign-in/begin` and `/poll` routes
  ([`providerDeviceSignInRoutes.ts`](../../apps/server/src/providers/oauth/providerDeviceSignInRoutes.ts))
  begin one, and they take only the caller the provider key routes take: the
  desktop bridge secret, no `Origin`, a loopback address, and a registered
  window capability. The private listener never forwards `/api/desktop`, so a
  paired device cannot reach them, and a browser on the host never holds the
  secret. Settings' `/api/providers/oauth` route never begins a device code,
  even when a command asks for one: the code is shown only in the terminal
  where the person typed the command, because a code shown on a page someone
  else can reach is how device-code phishing works. Both routes refuse an
  instance that has not opted in before any broker call, and the shared
  sign-in path checks the opt-in again for every caller.
- **The broker's device authorization.** The broker builds
  `{tenant}/oauth2/v2.0/devicecode` from the closed issuer host, so the
  descriptor still names no URL; it requests only the audience's scopes. It
  reads `device_code`, `user_code`, `verification_uri`, `expires_in`, and
  `interval`, never the directory's free-text `message`. The page must be
  https on `microsoft.com`, `login.microsoft.com`, or
  `login.microsoftonline.com`, with no port or credentials, and its text
  must be visible ASCII (the URL parser reads past an escape character or a
  line break that a terminal would act on), or the attempt is refused before
  any code is shown; the command refuses such a page again before printing. A code lives at most 15 minutes and is
  polled every 1 to 60 seconds. A 4xx answer (an app registration that does
  not allow public client flows, for one) is `exchange-refused`; a 429, a
  5xx, or no answer is `unavailable`.
- **Polling.** `authorization_pending` and `slow_down` wait;
  `authorization_declined` or `access_denied` is `denied`; `expired_token` is
  `timeout`; any other refusal is `exchange-refused`. No answer, a 429, or a
  5xx is transient: the broker polls again after a wait that doubles with
  each such answer in a row (up to a minute) and returns to the directory's
  interval after the next real answer, until the code expires. A code that
  runs out while the directory is still failing ends the attempt
  `unavailable` rather than `timeout`, since the person may never have been
  able to enter it. Rejected: ending the attempt at the first 5xx, which
  turned a brief outage into a failed sign-in and a new code. A finished sign-in passes the loopback flow's scope and identity-token
  checks without a nonce: none can be sent, and the token is the tenant
  token endpoint's answer to the attempt's own device code.
- **Consent.** The command prints the same consent line Settings shows (terms
  id `azure-foundry-directory-1`) and asks once per host; without a terminal
  to answer it starts nothing. Beside the code it prints a fixed sentence
  telling the person to enter a code only because they just ran the command.
- **An interrupted command.** Once a code is issued, the server follows the
  attempt until the broker settles it and stores the pointer then, so a
  sign-in finished after the command stopped waiting still names its grant.
  It reads the broker's answer with the descriptor the attempt began with,
  so a sign-in finished after its instance was removed, or stopped signing in
  with its organization, or whose pointer could not be stored, has its new
  grant forgotten: no refresh token is left without a pointer. A poll answers
  only the command (its window authority) that began the attempt, for that
  instance.

Rules slice 4 resolved for cloud-IAM signing and Amazon Bedrock, each the most
conservative reading of decision 4 and the broker operations above:

- **Source identity.** The cloud's single sign-on (IAM Identity Center): for
  each sign-in the broker registers a public client named Octant with the
  `sso:account:access` scope (so the portal issues a refresh token), starts a
  device authorization for the instance's access portal, polls for the
  session, and mints the role's temporary credentials before it stores
  anything, so a person the portal does not give the account and role holds
  no grant (`not-authorized`). Every address is built from the portal's
  region (`oidc.<region>.amazonaws.com`, `portal.sso.<region>.amazonaws.com`);
  nothing in a descriptor or an answer names a host. Polling the device code
  follows slice 2's rule: a poll the portal does not answer, or answers with
  a 429 or a 5xx, is retried with a doubling wait until the code expires, and
  a code that runs out during the outage reads `unavailable`. Every portal
  request carries the broker's one request deadline (see
  [Broker operations](#broker-operations)), so a stalled connection cannot
  hold an attempt awaiting consent past its code's expiry or keep Sign out
  waiting.
- **One partition.** Regions are the commercial partition's (`us-east-1`
  form); the government, isolated, sovereign, and China partitions sign under
  other hosts and keys and wait for an organization that needs one. The
  access portal is exactly `https://<name>.awsapps.com/start` or
  `https://ssoins-<id>.portal.<region>.app.aws`, the account twelve digits,
  the role a permission-set name.
- **Closed signing table.** A grant's scope is one row of the broker's own
  table: partition `aws`, service `bedrock`, host
  `bedrock-runtime.<region>.amazonaws.com`, path prefix `/model/`, method
  `POST`. The broker refuses a descriptor naming anything else before any
  request, and does not read a stored grant whose scope left the table. A
  probe or listing route on another host would widen the scope, so none is
  signed (see the probe rule).
- **What `sign` takes.** Exactly a credential reference, the request's method,
  host, path, query, headers, and payload hash, and an optional
  `renewCredentials`; a body carrying any other field (a digest, a canonical
  request, a date, a region, a service, a scope) is malformed and nothing is
  signed. Only `content-type` and `accept` may be signed besides the host and
  the broker's own date and session token. The path must be percent-encoded
  once, with no empty or dot segment (an escaped dot, `%2E`, counts as a dot,
  since the URL parser `fetch` follows resolves it away); the query holds at
  most eight visible ASCII pairs; the hash is 64 hex digits. A request
  outside the scope is `outside-scope` (read as `incompatible`) before any
  credential is renewed.
- **What a signature is.** `authorization`, `x-amz-date`, and
  `x-amz-security-token`. The role's session token travels in the last
  because the cloud requires it beside every signature made with temporary
  credentials; without the secret key it signs nothing, so it is a request
  credential, not reusable identity material. A driver refuses an answer
  naming any other header.
- **Renewal.** Role credentials are renewed five minutes before they expire,
  and the portal session one minute before, single-flight per grant. A
  renewal starts from the grant as stored when it begins, not the copy its
  caller read, so a signature that read the grant just before another renewal
  stored new credentials signs with those instead of renewing from a spent
  refresh token. A session refresh refused as `invalid_grant` or
  `expired_token` is `expired`; `invalid_client`, `unauthorized_client`, or
  `access_denied` is `revoked`; both drop the grant. The portal does not tell an administrator's revocation
  from a session that ran its course, so a withdrawn refresh token reads
  `expired`. A 401 from the role endpoint renews the session once; a second is
  `revoked`. A 403 or 404 there is `not-authorized` and keeps the grant, since
  an administrator may assign the role again. A 429, a 5xx, or no answer is
  transient and keeps it. A session without a refresh token ends with its
  access token.
- **Bedrock answers.** The transport reads only the `x-amzn-errortype` header
  of a 400, 401, or 403: `AccessDeniedException` is `not-authorized` and is not
  renewed; `ExpiredTokenException`, `UnrecognizedClientException`,
  `InvalidSignatureException`, `IncompleteSignatureException`,
  `MissingAuthenticationTokenException`, `InvalidClientTokenId`, and
  `SignatureDoesNotMatch` renew the role credentials once and resend once; a
  second refusal is `unauthenticated` (`revoked`). The real-account smoke
  confirms the codes.
- **Probe.** Bedrock has no free call that needs only the permission a turn
  needs: listing models needs another permission and lists models the role
  may not invoke. The probe asks the broker to sign a model request for the
  first configured model and sends nothing, which proves the sign-in, the
  role the portal gives, and the scope; a model the role may not invoke reads
  `not-authorized` on its first turn. Rejected: probing with a billed model
  request.
- **Transport.** The Converse stream API on the harness endpoint port, one
  request attempt, the model id one percent-encoded path segment. It sends no
  file attachments yet, so every model reads as text-only and an attachment is
  refused before any request; tool images ride along. A history that called
  tools is sent as text when the request offers no tools, because Converse
  refuses tool blocks without a tool list. The models are the instance's own
  list (1 to 64), never discovered.
- **Where a sign-in begins.** Only the host-local
  `/api/desktop/provider-sign-in/*` routes, for the callers slice 2 allows,
  and with no per-instance opt-in: the portal's device authorization is the
  only flow (decision 4). The page must be https, on the portal region's
  `device.sso.<region>.amazonaws.com` or the organization's own access portal
  host, with no port or credentials and only visible ASCII; the command shows
  slice 2's warning beside the code. Settings' route never begins one, and a
  remote principal is refused before any broker call. Terms
  (`amazon-bedrock-cloud-iam-1`) are acknowledged once per host in the record
  every host-driven sign-in uses, and the sign-in is journaled in the same
  public records. A sign-in finished after its instance was removed, or
  changed to another portal, account, role, or region, is forgotten.
- **No key on this kind.** An Amazon Bedrock instance signs in only with
  `cloud-iam`; the Bedrock API-key path stays an OpenAI-compatible instance,
  which satisfies "an API-key path stays available beside every sign-in".
- **Changing and removing.** Changing the region, portal, portal region,
  account, or role, or removing the instance, ends the portal session and
  deletes the grant before the change is journaled, and refuses the change
  when that cannot be done; changing only the model list keeps it. Signing out
  asks the portal to end the session and deletes the grant whatever the
  portal answers.
- **Settings.** Add endpoint creates an instance from the region, portal,
  portal region, account, role, and models, with no key; it is listed under
  Model endpoints, and its page names who is signed in and offers Sign out
  ([Providers and model endpoints](model-endpoints.md) owns the rows and
  copy). Settings' `/api/providers/oauth` route answers only `status` (whether
  the instance's stored pointer names a grant for its current binding; the
  account label is built from the configuration, so no broker call is made;
  the panel therefore defers to the endpoint's last check, and does not say
  Signed in as when that check found no grant) and `sign-out` for the Bedrock
  descriptor. Sign out is refused for a remote
  principal before the pointer is read; otherwise the broker asks the portal
  to end the session and deletes the grant, and only then is the pointer
  deleted and `host-oauth.signed-out` journaled, so a grant the broker could
  not delete stays named and can be signed out again. Every other command
  (`begin`, `acknowledge`, `poll`, `sign-out-locally`) is refused
  (`terminal-sign-in-only`) before any broker call: the sign-in still begins
  only in the host's terminal.

## Expiry, refresh, and revocation

- **Per-request resolution.** The bearer is resolved for each `send`, never once
  per `open`: a harness session outlives a token. The port's `open` resolves the
  endpoint and keeps the pointer; slice 1 corrects its doc comment to say so.
  The existing 15-second skew applies.
- **Refresh.** Single-flight in the broker. Expired or revoked refresh grants,
  a password reset, or an administrator's session revocation become
  sign-in-again (`expired` or `revoked`) and drop the stored grant. A policy
  that needs the person present again (multi-factor or a conditional access
  prompt) is `interaction-required`. Network failures, 5xx answers, and a
  refresh the issuer has not answered by the broker's request deadline are
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

| ID  | Threat                                                                 | Control                                                                                                                                                                                                                                                                                                                                                                                                                      | Owner slice |
| --- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| E1  | A directory refresh token is longer-lived than an API key              | Broker-only storage; never journaled, logged, exported, or renderer-visible; local sign-out deletes it and Settings says the directory session is not revoked; residual risk is a valid refresh token until the directory invalidates it                                                                                                                                                                                     | 1           |
| E2  | Reusable identity material reaches a provider child                    | Material classes above; harness endpoints have no child; spawning runtimes report the kinds `incompatible`; broker coordinates stay stripped; a conformance case proves a child environment carries neither class                                                                                                                                                                                                            | 1, 4        |
| E3  | Enterprise identity becomes a vendor-shaped host API                   | Kinds and ports in `@octant/provider-sdk`; the directory dialect is descriptor data; request signing is implemented from the documented algorithm with the platform's crypto, not a cloud SDK                                                                                                                                                                                                                                | 1, 4        |
| E4  | A thread or remote principal spends on the organization's account      | Mode, Project, and approval gates stay in front; remote principals cannot sign in, out, or rotate material                                                                                                                                                                                                                                                                                                                   | 1           |
| E5  | A mis-set instance talks to the wrong tenant or host                   | Four-point binding above; GUID tenant only; closed audience and endpoint host lists; a gateway's issuer fixed at creation and its bearer bound to the origin it was signed in for                                                                                                                                                                                                                                            | 1, 3        |
| E6  | A compromised server uses the signer as a general cloud oracle         | `sign` receives request fields, not a digest; the broker checks method, host, and path against the binding it stored (service, region, host, path prefix, method), builds the canonical request itself, and refuses everything else, so an allowed binding cannot cover another request; the server never holds a key                                                                                                        | 4           |
| E7  | A bearer leaks through an error, diagnostic, fork, or `journal-lookup` | Fixed Octant sentences for every failure; the bearer joins the turn's redacted credential values; secret-absence tests extend to the new kinds                                                                                                                                                                                                                                                                               | 1           |
| E8  | Consent phishing or a look-alike sign-in page                          | The broker builds authority URLs from a closed issuer host and the tenant GUID, or reads a gateway's from its fixed issuer's own discovery document on that issuer's origin; PKCE with one-shot loopback redirect and state; device code is opt-in per instance, begins only from the host-local command, and shows only a code and a page from a closed list (decision 2); a gateway signs in on the loopback redirect only | 1, 2, 3     |

## Conformance cases

A provider-sdk `runDirectoryOAuthConformance` (and, for `cloud-iam`,
`runCloudIamConformance`) proves these against a fake directory or signer and
a fake endpoint, reporting outcomes and never the token. Every direct-endpoint driver
that declares the kind also passes `runHarnessEndpointConformance`.

The runner proves the driver-facing rows: a driver supplies its audience, two
base URLs on its host list, and a factory that builds it against the runner's
fake broker, endpoint, and clock. The fake broker keeps the real broker's
rules (binding re-check, single-flight refresh, which refusals drop the
grant), so "grant kept" is proved by the driver recovering without a new
sign-in and "grant dropped" by its staying unauthenticated. The raw-resolve and
remote-principal rows concern the broker and the server, not a driver; slice
1b proves them against the broker, with the real dialect behind it, and the
server's principal gate. An issuer fixture (slice 3) is configured with the
organization's issuer, client, and scope instead of a tenant, so the
"pointer differs" row compares issuer, client, and scope, and the "base URL"
row proves the origin alone: a gateway has no host list. `runCloudIamConformance`
proves a cloud driver's rows the same way (a sign-in that ended, a role the
portal no longer gives, an unreachable broker, a pointer or grant naming
another portal, account, role, or region, a missing permission, and one
renewal of refused credentials), and its fake endpoint rebuilds each signature
from the request it received, so a driver that sends a body other than the one
signed fails. The four `cloud-iam` rows below concern the broker and the
server, and slice 4 proves them there.

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
   host without the desktop app (built in slice 2, from `octant provider sign-in`), never the default:
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
  multi-tenant aliases and secrets; provider policy and the Foundry driver
  refuse a `directory-oauth` configuration until 1c.
- **1b. Broker dialect.** Built. `directory-oidc` in the host OAuth runner:
  closed issuer host, tenant-specific authority, identity-token validation,
  binding on `access`, error-code mapping, local revoke. _Acceptance:_ a fake
  directory drives sign-in, refresh, every sign-in-again reason, and binding
  refusal; raw resolve refuses the grant; remote negatives refuse.
  _Verification:_ host-runtime tests. _Evidence:_ an HTTP fake directory
  (authorize, token, and key set, reached only through the closed issuer host)
  drives sign-in, single-flight refresh, each identity-token and scope flaw,
  every sign-in-again reason the dialect maps (`expired`, `revoked`, and
  `interaction-required`, which keeps the grant), transient answers that keep
  it, and local sign-out; the broker's routes refuse every mismatched,
  missing, or foreign binding, a raw resolve of the grant, and a non-loopback,
  tokenless, or browser caller for begin, refresh, access, and sign-out, with
  nothing changed; the server refuses a remote refresh or sign-out before any
  broker call; and a secret-absence run finds no code, token, or verifier in
  any broker answer or console line except the one access token `access`
  releases under its binding.
- **1c. Foundry driver and Settings.** Built. The Foundry driver, already on
  the harness endpoint port, sends the bearer per request, probes with it, and
  redacts it; Add endpoint offers Sign in beside the key with tenant and client
  id fields; [Providers and model endpoints](model-endpoints.md), architecture,
  and the user guide are updated. _Acceptance:_ a Foundry instance signed in
  against fakes runs a Chat, Work, and Code turn; readiness states render;
  secret-absence passes. _Verification:_ server tests, web component test,
  rendered QA of the Settings states. _Evidence:_ the real Foundry driver passes
  every driver-facing `runDirectoryOAuthConformance` case and
  `runHarnessEndpointConformance` while signed in; a signed-in instance runs a
  Chat, a Work, and a Code turn with a bearer on every request and no key; a
  token from another tenant reads `incompatible` and a 401 naming a missing
  role `not-authorized`, neither renewed; an API-key instance never sends a
  stored pointer; the route signs in from the instance's own binding, keeps an
  `interaction-required` pointer, forgets a replaced grant, and signs out
  locally; switching sign-in method, tenant, or client and removing the
  instance clear the credential; the journal-level secret-absence run finds no
  token; and Settings tests render Sign in to use, Sign in again (in person),
  Signed out, No access, and Sign-in doesn't match, keep an organization
  sign-in on save with pasted ids lowercased, and show who is signed in.
- **Needs the maintainer:** a real-tenant smoke (an Entra tenant, an app
  registration, a Foundry resource with a role assignment; billed). Until it
  runs it is a named blocker on closing slice 1, not on reviewing it. It
  confirms: a public client registered with the redirect URI
  `http://127.0.0.1/oauth/callback` (Mobile and desktop applications) and the
  delegated Azure Cognitive Services `user_impersonation` permission accepts
  the loopback redirect on the broker's ephemeral port; sign-in completes, the
  echoed scope sits under `https://cognitiveservices.azure.com`, `tid` matches,
  and Settings names the account; the bearer is accepted by the OpenAI v1
  endpoint on both an `.openai.azure.com` and a `.services.ai.azure.com`
  address for the model list and a Chat, a Work, and a Code turn; an account
  without a role is answered with the code the transport reads as
  `not-authorized` (`PermissionDenied`, or record the actual code and status);
  a token from another tenant is answered with `InvalidAuthenticationTokenTenant`
  (or record the actual code); a refresh after the access token expires keeps
  the endpoint ready; a conditional-access or multi-factor prompt on refresh
  reads Sign in again and signing in again recovers; and Sign out leaves the
  endpoint signed out on this computer.

Why Foundry with Entra first: its driver and Settings already exist, so the
slice is authentication only; the token is a bearer whose audience is the model
resource, so it fits the request-credential class with no broker relay or
signer; the host OAuth runner already does PKCE, refresh, and identity-token
validation; and the tenant binding is explicit in the identity token. Bedrock
needs a new wire transport and a signer, and Vertex needs a relay, so either
would be several slices before the first sign-in.

**Slice 2: device-code sign-in for hosts without the desktop app**
(decision 2). Built; stacks on slice 1. `octant provider sign-in` on the
host, opt-in per instance (rules above). _Acceptance:_ a headless host signs
in with device code against a fake directory; remote principals cannot start
it. Linux container capable. _Evidence:_ the broker's directory dialect,
against the HTTP fake directory's device authorization endpoint, issues a
code at the tenant's own authority for only the audience, shows only the page
and code, and stores a grant bound like a loopback one once the person
approves; a declined or expired code, each identity-token flaw, a scope off
the audience, a page off the closed list, and a refused or unreachable device
authorization each store nothing; the broker's routes answer the same, and
refuse a non-loopback, tokenless, or browser caller's device-code begin with
no directory request; the secret-absence run finds no device code or token in
any answer. The host-local routes sign an opted-in instance in from its own
binding and keep the pointer, finish a sign-in after the command stops
waiting, forget the grant of one finished after its instance was removed, and
refuse an instance that has not opted in, one without an
organization sign-in, a caller without the bridge secret, a browser page, a
non-loopback address, a caller without a window authority, and another
command's poll, each before any broker call; Settings' route never begins a
device code; the remote forward-list gate proves the private listener does
not forward either route. The command shows the page, code, and warning,
asks before accepting the terms, and explains every refusal; Settings keeps
the opt-in on save and drops it when unchecked.

- **Needs the maintainer:** a real-tenant smoke with the slice 1 app
  registration and **Allow public client flows** set to Yes, from a headless
  Linux host with an unlocked Secret Service: `octant provider sign-in`
  prints a page on the closed list (record the `verification_uri` the
  directory returns); entering the code on another device signs the endpoint
  in, Settings names the account, and a Chat turn runs; a code left to expire
  and a declined sign-in read as such; and a registration without public
  client flows, and a tenant whose conditional access blocks device-code
  sign-in, are refused (record the codes the directory returns).

**Slice 3: directory sign-in for OpenAI-compatible and Anthropic-compatible
gateways.** Built. A generic OIDC directory dialect for an organization's own
model gateway, with the issuer host fixed per instance at creation.
_Acceptance:_ the conformance cases pass for both drivers. Linux container
capable; a real gateway smoke needs the maintainer. _Verification:_
provider-sdk, host-runtime, domain, server, and web tests. _Evidence:_ the
real OpenAI-compatible and Anthropic-compatible drivers each pass every
driver-facing `runDirectoryOAuthConformance` case for an issuer fixture and
`runHarnessEndpointConformance` while signed in, run a Chat, a Work, and a Code
turn with a bearer on every request and no key, read a 403 as `not-authorized`
without renewing, read a missing broker as `unavailable` and a stored key as no
sign-in, sending nothing; the reference driver passes the issuer cases and one
that binds to its pointer fails them; an HTTP fake issuer drives sign-in
through discovery, refuses each discovery flaw before a listener opens, each
identity-token and echoed-scope flaw, every binding but its own (a tenant
binding included), and keeps or drops the grant for each refresh answer; the
broker's routes refuse a mixed binding and a raw resolve; secret-absence runs
find no issuer token, code, or verifier in a broker answer or the console, and
no bearer in the journal, a lookup, a fork copy, events, or failures for either
gateway driver; provider policy fixes the issuer at creation; the route signs
a gateway in from its own configuration and refuses another kind's sign-in or
a catalog sign-in over it; changing client, scope, or address or removing the
gateway forgets the grant; and Settings adds a gateway with no key, keeps its
sign-in on save with the issuer shown but not editable, and reads its states
without an Azure role; and a device-code sign-in is refused for a gateway by
the contract, the broker, and the host-local command.
**Needs the maintainer:** a real-gateway smoke against one organization's
issuer and gateway (billed if the gateway bills). It confirms: a public client
registered with the loopback redirect URI `http://127.0.0.1/oauth/callback` on
any port; the issuer's discovery document passes the same-origin rule (record
the provider if it does not); sign-in completes, the echoed scope names the
gateway scope, and Settings names the account; the gateway accepts the bearer
for its model list and a Chat, a Work, and a Code turn on both an
OpenAI-compatible and an Anthropic-compatible endpoint; an account without
access is answered with 403 (or record the actual status); a refresh after the
access token expires keeps the endpoint ready; and Sign out leaves the
endpoint signed out on this computer.

**Slice 4: cloud-IAM signer and Amazon Bedrock.** Built. `/v1/cloud-iam/*`,
the single-sign-on source identity (decision 4), request signing in
host-runtime, and a Bedrock transport on the harness endpoint port (rules
above). _Acceptance:_ the `cloud-iam` conformance cases pass; a request
outside the binding is refused; the broker builds every canonical request from
request fields; the server process never holds a key. Linux container capable
against fakes; a real smoke needs an AWS organization and billed Bedrock
access. _Verification:_ contracts, domain, provider-sdk, host-runtime, server,
and CLI tests. _Evidence:_ Signature Version 4 reproduces the cloud's
published signing-key and signature examples, including its test suite's
query-order, UTF-8, header-trim, unreserved-path, session-token, and form-body
cases; against an in-memory portal
and a Bedrock endpoint that rebuilds each signature from the request it
received, the broker signs in with a device code at the portal's own page,
mints the role before storing anything, stores nothing for a declined or
expired code or a person without the role, refuses a page off the portal's
hosts and a descriptor outside the closed table before any request, refuses
every request outside the scope and every sign body that brings its own
digest, date, or scope without renewing or signing, produces a signature that
fails for a changed method, host, path, query, signed header, or payload,
renews credentials once for concurrent signatures, signs with credentials
another signature renewed after it read the grant, renews an ended session,
drops or keeps the grant for each session and role answer, refuses a raw
resolve and a browser, tokenless, or remote caller, signs out at the portal
even when it is down, and answers with no client secret, device code, portal
token, or role key; the reference driver passes every driver-facing
`runCloudIamConformance` case and drivers that bind to the pointer, send a
body other than the one signed, give up on refused credentials, or echo the
signature fail it; the real Bedrock driver passes every driver-facing case,
`runHarnessEndpointConformance`, and the provider and Chat conformance
runners; end to end, with the real broker, the host-local route signs an
instance in, a Chat, a Work, and a Code turn each go out with a signature the
broker made, and no broker answer, event, failure, readiness, journal record,
or pointer carries a cloud secret, nor a child environment the broker's
coordinates or a signature; a sign-in finished after its instance was removed
or changed is forgotten; provider policy and the contract refuse other
partitions and look-alike portals; changing the region, portal, account, or
role, or removing the instance, forgets the grant, and a model list change
does not; Settings' route never begins a cloud sign-in, and a remote principal
is refused one before any broker call. The Settings follow-up's evidence:
end to end with the real broker, Settings' route reads an instance signed
out, then signed in as its role and account after the host-local sign-in,
and its Sign out asks the portal to end the session and leaves no grant or
pointer; a remote principal's Sign out and every other Settings command are
refused with no broker call; and web tests add an endpoint from the Connect
fields (tidying a pasted account and portal, refusing a look-alike portal),
read each row state, name the terminal command with Check again as the only
fix, and save the role on the endpoint's page with no key. Device-code
polls that the directory or portal could not answer are retried with a
doubling wait until the code expires, and settled attempts are forgotten
five minutes past their deadline, each proved against the HTTP fake
directory and the in-memory portal; a portal poll that never answers is
abandoned and polled again, a directory `slow_down` keeps its longer interval
through a later outage, and the endpoint's page does not say Signed in as when
its last check found no grant. Every issuer and portal request carries the one
request deadline: a directory, standard, or portal device-code poll that never
answers or stops partway through its answer is abandoned and polled again, a
refresh that does is transient and leaves the grant for the next try, and an
issuer whose discovery document does refuses the sign-in as unavailable. An
Amazon Bedrock row names the role and account signed in from the host's
status, with no broker call, and not once its last check found the sign-in
gone; a Foundry or gateway row names the account once its page has read it.
**Needs the maintainer:** a real-account smoke with an AWS organization using
IAM Identity Center and billed Bedrock access in one commercial region (for
example `us-west-2`): a permission set allowing `bedrock:InvokeModel` and
`bedrock:InvokeModelWithResponseStream` on one model, assigned to the
maintainer in one account; then, with `OCTANT_BEDROCK_CLOUD_IAM_SMOKE=1`,
`OCTANT_BEDROCK_SMOKE_START_URL`, `OCTANT_BEDROCK_SMOKE_SSO_REGION`,
`OCTANT_BEDROCK_SMOKE_REGION`, `OCTANT_BEDROCK_SMOKE_ACCOUNT_ID`,
`OCTANT_BEDROCK_SMOKE_ROLE_NAME`, `OCTANT_BEDROCK_SMOKE_MODEL`, and optionally
`OCTANT_BEDROCK_SMOKE_DENIED_MODEL` (a model the permission set does not
allow) set, run
`bun run test:evidence -- src/providers/amazonBedrockCloudIamSmoke.integration.test.ts`
in `apps/server` and enter the printed code in a browser. It confirms: the
device page the portal returns is on the accepted list (record the
`verificationUri` it prints); the role is minted, the probe reads ready, and
a Converse turn streams with the broker's signature; a model the permission
set does not allow reads `not-authorized` (record the error type Bedrock
sends); and sign-out deletes the grant. Run it once more with
`OCTANT_BEDROCK_SMOKE_ROLE_NAME` set to a role the maintainer is not assigned
and `OCTANT_BEDROCK_SMOKE_EXPECT_NOT_AUTHORIZED=1`: the sign-in must be refused
`not-authorized` with nothing stored.

**Later, each needing its own maintainer decision:** Google Vertex through a broker relay (decision 5);
spawning runtimes on enterprise identity (decision 6); an Octant-published
directory client (decision 1b).

## Verification

Prose alone needs no test. Each slice's evidence is its conformance run, its
permission negatives (remote principal, raw resolve, child environment), the
secret-absence suite, and, for closure, the real-account smoke named above.
