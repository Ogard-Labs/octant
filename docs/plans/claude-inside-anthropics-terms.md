# Claude inside Anthropic's terms

Remediation for [0165](../decisions/0165-claude-runs-inside-anthropics-terms.md).
This plan is product work, not legal advice. It does not authorize merging.

The helper-token path stays in the tree until a later implementation PR
lands these steps. This document is the order of that work.

## Goal

Octant never collects, stores, scrapes, or forwards Claude.ai OAuth or
setup tokens. The person signs in through the unmodified `claude` binary.
Confined Plan and subagent launches keep that same sign-in by granting
the sandbox the account's Claude-owned config directory. Several accounts
may come later on that same mechanism; they are not this remediation.

## Step 0 — Must-verify macOS login storage

**Gate.** Do not implement the confined-launch replacement until this is
measured on a current Claude Code build on macOS.

Anthropic's Authentication page (fetched 10 Oct 2026) says:

- On macOS, credentials are stored in the encrypted macOS Keychain.
- When the Keychain rejects the write, Claude Code stores the login in
  `~/.claude/.credentials.json` with mode `0600`.
- If `CLAUDE_CONFIG_DIR` is set, Claude Code keeps `.credentials.json`
  under that directory, including the macOS fallback file, and keys the
  Keychain entry to that directory.

Measure:

1. Create an empty directory. Launch unmodified `claude` with
   `CLAUDE_CONFIG_DIR` (and `CLAUDE_SECURESTORAGE_CONFIG_DIR` if it is
   distinct) pointed at it. Run `claude auth login` and complete
   Anthropic's flow.
2. Observe where the login landed: a `.credentials.json` under that
   directory, a Keychain item keyed to that directory, both, or
   elsewhere. Octant must not read the file or the Keychain item to
   learn this; watch Claude's own documented locations and `/status`.
3. Launch the same binary under Octant's Plan confinement with
   read/write on only that directory (and the launch's temporary
   directory). Do not grant `/usr/bin/security` or the Keychain file.
   Report whether the binary is signed in.
4. If it is signed out, try the smallest extra grant that still never
   hands Octant a token: the security-server lookup 0145 already
   described, scoped to this launch, with the Keychain file still
   denied. Report whether that is enough.
5. Record what `CLAUDE_SECURESTORAGE_CONFIG_DIR` does on this build. It
   is already threaded in `claudeEnvironment.ts` and is not listed in
   Anthropic's public environment-variable table fetched on 10 Oct 2026.

**Pass.** The unmodified binary signs in on a confined Plan launch from
Claude-owned storage, and Octant never reads or sets a token.

**Fail.** Confined subscription launches cannot sign in that way. The
fallback is an Anthropic API key for confined launches only. Ordinary
unconfined turns keep the person's CLI login. Write the failure into
0165 before implementing the fallback.

**Touches (notes only):** a short evidence note on the implementation
PR. No product code in this step.

## Step 1 — Remove Connect Claude for helpers

Stop minting, storing, and injecting the helper token. Keep the person's
ordinary CLI login for unconfined turns.

**Migration, on first launch after the change:**

1. Delete every `claude-helper-sign-in` envelope from the credential
   broker.
2. Tell the person the stored helper token is gone and that Octant
   cannot revoke it with Anthropic; they revoke it in their Claude
   account.
3. Do not treat an API key in the same broker slot as a helper token.
   0005's API-key path stays.

**Files:**

- `apps/server/src/providers/claudeSetupToken.ts` and its test
- `apps/server/src/providers/claudeHelperSignIn.ts` and its test
- `apps/server/src/providers/claudeHelperSignInRoutes.ts`
- `apps/server/src/providers/claudeDriver.ts` (confined subscription
  launch, `connectedHelperToken`, `helperTokenRefusal`)
- `apps/server/src/providers/claudeEnvironment.ts` (`oauthToken`,
  `CLAUDE_CODE_OAUTH_TOKEN`)
- `apps/web/src/providers/ClaudeHelperSignIn.tsx` and its test
- `apps/web/src/providers/ProviderSettingsView.tsx`
- Settings and provider-service routes that expose connect / disconnect
- `docs/architecture.md` (Providers, confined Claude launch)
- `docs/security/security-architecture-threat-model.md`

**Acceptance:**

- Settings has no Connect / Disconnect / expired helper-token row.
- No Octant path stores a Claude setup or OAuth token in the broker.
- A previously stored helper token is gone after migration.
- Unconfined subscription turns still use the CLI login Claude owns.

## Step 2 — Confined launches use the Claude-owned config directory

Primary path, only after Step 0 passes.

Each Claude account (the default account first) has a Claude-owned
config directory. A confined Plan or subagent launch sets
`CLAUDE_CONFIG_DIR` and, when needed, `CLAUDE_SECURESTORAGE_CONFIG_DIR`
to that directory. The shared confinement builder grants read and write
on exactly those directories and the launch's temporary directory. It
does not grant `/usr/bin/security` or the Keychain file unless Step 0
proved a narrowly scoped lookup is required and still never exposes the
token to Octant.

The person signs in once with unmodified `claude auth login` (Anthropic's
flow) against that directory. Octant does not read the directory's
credential file.

If Step 0 failed, confined launches require an Anthropic API key instead.
Say so in Settings. Do not reintroduce a setup token.

**Files:**

- `apps/server/src/providers/claudeEnvironment.ts`
- `apps/server/src/providers/claudeProcess.ts`
  (`claudeRuntimeStateDirectories`, `allowProviderCredentialLookup`)
- `apps/server/src/providers/claudeDriver.ts`
- `apps/server/src/process/seatbeltProfile.ts` and the Linux builder
- Settings copy that today asks the person to Connect Claude for helpers
- `docs/architecture.md` (0145 / confined Claude launch)

**Acceptance:**

- A confined Plan turn and a Chat subagent on a subscription instance
  sign in without `CLAUDE_CODE_OAUTH_TOKEN` in the launch environment.
- Octant never reads `.credentials.json` or a Keychain item.
- A launch whose config directory is missing or unsigned-in refuses with
  a step the person can take (`claude auth login` in that directory, or
  store an API key if this is the fallback).
- The Keychain file and `/usr/bin/security` stay denied unless Step 0
  recorded a scoped exception.

## Step 3 — Telemetry on subscription launches

On subscription launches of the unmodified binary, stop setting
`DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING`, and
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`. Keep `DISABLE_AUTOUPDATER`,
`CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL`,
`CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS`, and
`CLAUDE_CODE_DISABLE_AUTO_MEMORY`.

API-key launches may keep the 0005 telemetry guards.

**Files:**

- `apps/server/src/providers/claudeEnvironment.ts` (`REQUIRED_GUARDS`)
- `apps/server/src/providers/claudeEnvironment.test.ts`
- `apps/server/src/providers/claudeProcess.ts` / its test if they assert
  the three subscription guards

**Acceptance:**

- A subscription launch's environment does not contain those three
  switches.
- An API-key launch still sets them.
- The other process-ownership switches remain on every launch.

## Step 4 — Docs and Settings copy

User-facing docs already mark the helper token as deprecated by 0165.
When the code lands, replace that deprecated behavior with the
config-directory rule. Architecture and the threat model change in the
same implementation PR.

Do not present Claude login as an Octant-owned connect step. The native
harness remains an optional Anthropic API key on an Anthropic-compatible
HTTP endpoint. Do not add Claude subscription OAuth there.

**Files:**

- `apps/docs/advanced/providers.md`
- `apps/docs/advanced/privacy-notice.md`
- `apps/docs/advanced/privacy-and-security.md`
- `apps/docs/advanced/sub-processors.md`
- `apps/docs/advanced/subagents.md`
- `docs/architecture.md`
- `docs/security/security-architecture-threat-model.md`
- Settings strings in `ClaudeHelperSignIn.tsx` (removed in Step 1) and
  any remaining "Connect Claude for helpers" copy

**Acceptance:**

- No shipped page tells the person to Connect Claude for helpers.
- Privacy text no longer says Octant stores a Claude setup token.
- The Providers guide describes `claude auth login` into a Claude-owned
  config directory, and the optional native-harness API key.

## Step 5 — Tests that enforce the rule

Add a focused test (and a lint or grep gate if a test alone can be
skipped) that fails if Octant sets `CLAUDE_CODE_OAUTH_TOKEN` from its
own storage.

**Files:**

- `apps/server/src/providers/claudeEnvironment.test.ts`
- `apps/server/src/providers/claudeDriver.test.ts`
- A small repo check next to the existing provider tests, or an
  assertion in `sanitizeClaudeEnvironment` that the variable is absent
  unless it arrived from the host environment for a reason 0165 does
  not allow — in practice it must stay absent.

**Acceptance:**

- `sanitizeClaudeEnvironment` and the Claude driver never assign
  `CLAUDE_CODE_OAUTH_TOKEN` from the broker, a scraped `setup-token`,
  or any other Octant-held secret.
- Existing tests that required a helper token are rewritten against the
  config-directory path (or the API-key fallback).
- `git diff --check` and the server/web tests for the touched surfaces
  pass.

## Later, optional — several Claude accounts

Not part of this remediation. Build it only after Steps 0–5 have landed,
and only on the same Claude-owned config-directory mechanism.

Allowed:

- One Claude-owned config directory per account (`CLAUDE_CONFIG_DIR`,
  plus `CLAUDE_SECURESTORAGE_CONFIG_DIR` when distinct).
- The person signs in once per account with unmodified
  `claude auth login`.
- Octant never reads, copies, or stores the credentials.
- The person picks the account explicitly. A thread stays on the
  account it started with.

Refused:

- Automatic failover or rotation when a usage limit is hit.
- Load-balancing across subscriptions.
- Any feature that pools several subscriptions to get around limits.

**Likely files (when this work is authorized):** provider registry and
Settings account list, model picker account choice, thread pinning,
`claudeEnvironment.ts`, confinement grants, user docs.

**Acceptance (when authorized):** two accounts can be signed in at once;
a thread cannot silently move; a usage-limit refusal does not start the
same turn on another account.

## Out of scope

- Product code in the decision PR that added 0165.
- Host-driven Claude subscription OAuth on the native harness or on
  Anthropic-compatible HTTP (refused).
- Reading `~/.claude/.credentials.json` or the Keychain from Octant.
- Changing 0102 local usage history. It already reads bounded local
  transcript files and does not call Anthropic with a subscription
  credential.
