# 0111. Host-driven provider OAuth auth kind and broker

**Status:** Proposed

## Context

0005 delegates provider-native OAuth to the provider runtime and says Octant
never stores those tokens. That remains the right rule for CLI-owned login
(Codex CLI, Claude, `kimi login`, ACP `subscription`). Direct HTTP drivers
have no such runtime, so a ChatGPT or Grok subscription cannot sign in on the
native harness except by pasting an API key.

0054 already holds API keys as opaque refs in the host credential broker.
Settings Linear OAuth already uses host-owned PKCE into that same store.
Neither names consumer subscription OAuth on an `openai-compatible-http`
endpoint. Directory ID and cloud-IAM stay a different note
(`docs/enterprise-provider-identity.md`).

This record is design only. It does not authorize implementation.

## Decision

- **Two auth postures, one vocabulary.** Endpoint configuration
  (`OpenAiCompatibleProviderConfiguration` and siblings) keeps `bearer`,
  `api-key`, and `none`, and gains:
  - `delegated-oauth` — provider-runtime-owned login. Octant never reads,
    stores, renders, refreshes, exports, or journals those tokens. Existing
    CLI `subscription` is this posture; that literal is not renamed.
  - `subscription-oauth` — host-driven OAuth for direct HTTP drivers. The
    host owns PKCE and/or device flow. The 0054 broker stores refresh and
    access material as opaque refs — never journaled, logged, exported, or
    renderer-visible.
- **Readiness.** Missing or rejected subscription material →
  `unauthenticated`. A driver that cannot represent the kind safely →
  `incompatible`. Missing or unreachable broker or secret store → existing
  `unavailable` (0054). Never silently fall back to API-key mode.
- **Broker operations** live in host-runtime (0054), not `apps/server` and
  not the renderer. Drivers may: store a credential (opaque ref); resolve a
  scoped handle for one request; refresh with single-flight and rotation
  safety. `refresh_token_reused` is terminal; network and 5xx are transient.
  Drivers never hold durable tokens in process state that outlives a
  request. The server still reaches the broker only through
  `OCTANT_CREDENTIAL_BROKER_*`. Do not reuse raw-string `resolve` if that
  would place a reusable refresh token in a provider child; prefer a scoped
  handle.
- **Client identity.** Octant identifies as itself (`originator`, client
  metadata). Per provider: reuse a vendor's public first-party `client_id`
  only when that is the vendor's documented consumer path and the ToS
  acknowledgment gate has been passed (ChatGPT/Codex and Grok, when so
  documented). Register Octant's own OAuth client where the vendor issues
  partner IDs (MiniMax). Seek partner registration first when the vendor
  requires it. Anthropic is excluded per vendor prohibition. OpenRouter
  needs no OAuth. The API-key path is always offered; `subscription-oauth`
  is never the only way to authenticate a direct endpoint.
- **ToS gate.** Explicit user acknowledgment before any first-party-client-ID
  flow. Product requirement, not a footer.
- **Remote.** Credential changes stay local-host-required (0013). A remote
  principal cannot start the OAuth flow or rotate broker material.
- **Scoped exception to 0005.** 0005 stays Accepted. This record supersedes
  only the universal reading of "Octant never stores provider-native OAuth
  tokens." Remaining 0005 rules stand, including that CLI-owned and other
  `delegated-oauth` flows still never have their tokens stored. The exception
  is only host-driven `subscription-oauth` opaque refs in the 0054 broker.
- **Enterprise identity stays separate.** Directory ID and cloud-IAM are not
  this record.
- **Does not authorize implementation.** No child lands until this record is
  Proposed or Accepted and an explicit maintainer request authorizes it.

## Consequences

- Direct HTTP drivers can grow a ChatGPT or Grok subscription sign-in without
  teaching `apps/server` a secret store or weakening CLI-owned login.
- The broker's closed route set will need store, scoped-handle resolve, and
  refresh operations before any child can land; raw-string `resolve` stays
  the API-key path.
- First-party `client_id` reuse is gated and never the only auth path, so a
  vendor prohibition (Anthropic) is an `incompatible` kind, not a workaround.

## Related

- 0005 Provider SDK contract (scoped exception above)
- 0007 Direct API providers and the native agent harness
- 0013 Remote access (credential changes local-host-required)
- 0054 Headless host credential store
- `docs/enterprise-provider-identity.md` (directory ID / cloud-IAM, not this)
- `docs/security/security-architecture-threat-model.md` (O1–O5 delta)
