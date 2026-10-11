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
4. If it is signed out, try only the scoped security-server lookup
   0145 already described, scoped to this launch. Never grant
   `/usr/bin/security` or the Keychain file: the threat model records
   that the tool can return unrelated programs' trusted tokens. If
   that lookup is not enough, this step fails and the instance takes
   the API-key fallback.
5. Record what `CLAUDE_SECURESTORAGE_CONFIG_DIR` does on this build. It
   is already threaded in `claudeEnvironment.ts` and is not listed in
   Anthropic's public environment-variable table fetched on 10 Oct 2026.
6. Observe whether the login can live in a credential-only path
   distinct from session history. Anthropic documents
   `CLAUDE_CONFIG_DIR` as settings, session history, and login
   together. If `CLAUDE_SECURESTORAGE_CONFIG_DIR` (or another
   documented location) holds the login independently of session
   files, record that split. If they cannot be separated, record that
   confined subscription launches are refused: a bound root cannot
   receive another Project's session files.

**Pass.** The unmodified binary signs in on a confined Plan launch from
Claude-owned storage, and Octant never reads or sets a token.

**Version.** Record the exact Claude Code version, or an attested
inclusive range, that passed the full storage-isolation measurement.
The secure-storage variable is undocumented and build-specific, and
the driver records `probeVersion` without a floor today. A pass on
one current build therefore does not cover every installed binary,
including a newer build the person installed later. Probe each
configured `claude` executable. Refuse confined subscription when the
binary is outside that attested range or fails the same capability
check. Do not treat a newer unattested version as compatible only
because it is above a floor; rerun this Step 0 measurement first.
Ordinary unconfined turns on an unattested binary may still run;
confined login after helper-token removal must not assume they work.
An unattested or inseparable-storage result is not the instance-wide
API-key fallback.

**Fail.** Confined subscription launches cannot sign in from
Claude-owned storage at all (the binary stays signed out after the
scoped 0145 lookup). That is the only path that switches the instance
to Anthropic API-key authentication for every launch, including
ordinary unconfined turns. Inseparable login and session history is
not this failure: record it in measurement 6 and refuse only confined
subscription launches. The current
provider model has one `authentication` value per instance, so mixed
"CLI login when unconfined, API key when confined" is not available.
A stored Claude resume cursor records that instance's
`authentication`. Changing it to `api-key` makes every existing
cursor `stale-resume`, including ordinary unconfined threads. Do not
rewrite those cursors as API-key identity: the session files still
belong to the subscription login. Before the switch, require an
explicit new-thread transition: refuse the change while those threads
can still resume, or mark them as needing a new thread and do not
resume them after the switch. Write the failure, the instance-wide
switch, and that transition into 0165 before implementing it.

**Touches (notes only):** a short evidence note on the implementation
PR. No product code in this step.

## Step 1 — Remove Connect Claude for helpers

Stop minting, storing, and injecting the helper token. Keep the person's
ordinary CLI login for unconfined turns.

**Migration, on first launch after the change:**

1. Delete every `claude-helper-sign-in` envelope from the credential
   broker. The broker today only addresses envelopes by instance ID
   (`has` / `resolve` / `set` / `delete`). A provider removed while the
   broker was unreachable can leave an orphaned helper envelope with no
   instance to name. This step therefore adds a scoped native cleanup
   that can find helper-token envelopes without listing unrelated API
   keys, then deletes those envelopes.
2. Tell the person the stored helper token is gone and that Octant
   cannot revoke it with Anthropic; they revoke it in their Claude
   account.
3. Do not treat an API key in the same broker slot as a helper token.
   0005's API-key path stays.

The existing credential cleanup boundary distinguishes `unavailable`,
`partial`, and `indeterminate` because deletion cannot be assumed.
Keep this migration pending and retry or reconcile on later launches
until the scoped cleanup reports complete. Do not show the
notification that the token is gone, and do not treat the migration
as finished, while the broker is locked, the first attempt is
partial, or the destructive response is lost.

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
- A previously stored helper token is gone after migration confirms
  deletion. A launch that cannot reach the broker leaves the
  migration pending.
- Unconfined subscription turns still use the CLI login Claude owns.

## Step 2 — Confined launches use the Claude-owned config directory

Primary path, only after Step 0 passes.

Each Claude account (the default account first) has a Claude-owned
config directory. A confined Plan or subagent launch sets
`CLAUDE_CONFIG_DIR` and, when needed, `CLAUDE_SECURESTORAGE_CONFIG_DIR`
to that directory. The shared confinement builder grants read and write
on exactly those directories and the launch's temporary directory. It
never grants `/usr/bin/security` or the Keychain file. Those denials
are unconditional. The 0145 scoped security-server lookup may stay if
Step 0 recorded that it is required; it still never exposes the token
to Octant.

If Step 0 showed the login can live in a credential-only directory
distinct from session history, grant that credential path plus a
durable per-thread session directory on every launch for that
thread, confined or not. A later Plan or ordinary turn has to find
the same session files; mixing the per-thread root with the account
root makes the saved cursor `stale-resume`. Do not use a throwaway
per-launch config directory: resume has to find the same session
files after a restart. That session directory is thread-owned. Confirmed
purge must delete it with the thread. A third-party driver has no
way to register thread-owned storage today, so do not add a
Claude-only path to `hostDataMap` or the purge sweep. First add a
provider-neutral storage/lifecycle seam on `@octant/provider-sdk`:
the driver registers a path receipt; the host data map and purge
sweep only see registered locations. Claude consumes that seam.
Report deletion or failure, and cover it with a purge test. Leaving
the transcript on disk after a successful purge is a privacy defect.
Resume lookup must use that same per-thread root. `findSession`
today calls `listSessions` against the project
directory and the server's default Claude store unless it receives
the launch session root. Pass that root into the lookup without
mutating process-global environment: threads can resume concurrently.
Cover restart resume for subscription and API-key roots. Threads that already started under the helper-
token path still have their history in the account config tree. Do
not relocate those threads into an empty per-thread directory: that
makes the saved cursor `stale-resume`. Unconfined later launches may
keep that account session root. Existing confined Chat or Plan
threads cannot keep it: granting the account tree on the next
confined launch would expose another Project's transcripts. Those
confined threads take an explicit new-thread transition before the
next confined subscription launch.

Do not grant the shared session tree to a confined Chat subagent or
Plan turn that would otherwise read another Project's history. If
the login is inseparable from the account config tree, refuse
confined subscription launches (Chat, Work Plan, and Code Plan).
Unconfined turns may still use the CLI login. Do not invent a split
the unmodified binary does not support, and do not switch the whole
instance to an API key only because confined launches cannot share
history.

The person signs in once with unmodified `claude auth login` (Anthropic's
flow) against that directory. Octant does not read the directory's
credential file.

If Step 0 **Fail**ed because confined sign-in itself did not work,
confined launches require an Anthropic API key instead. That is the
same instance-wide switch Step 0 recorded, including its new-thread
transition for existing subscription resume cursors. Inseparable
storage is not that failure and does not take this switch. New
API-key threads after that switch still need a durable per-thread
session directory: the current throwaway `octant-claude-config-*`
scope deletes history when the connection closes, so a later resume
fails `findSession`. Grant the same durable session root on those
fallback launches and cover restart resume. Say so in Settings. Do
not reintroduce a setup token.

**Files:**

- `apps/server/src/providers/claudeEnvironment.ts`
- `apps/server/src/providers/claudeProcess.ts`
  (`claudeRuntimeStateDirectories`, `allowProviderCredentialLookup`)
- `apps/server/src/providers/claudeDriver.ts`
- `apps/server/src/providers/claudeAgentSdkPort.ts` (`findSession`)
- `@octant/provider-sdk` thread-owned storage/lifecycle seam, then the
  host data map and purge sweep that consume registered receipts
- `apps/server/src/process/seatbeltProfile.ts` and the Linux builder
- Settings copy that today asks the person to Connect Claude for helpers
- `docs/architecture.md` (0145 / confined Claude launch)

**Acceptance:**

- A confined Plan turn on a subscription instance signs in without
  `CLAUDE_CODE_OAUTH_TOKEN` in the launch environment only when
  Step 0 found a credential directory that can be granted without
  the shared session tree; otherwise confined Chat, Work Plan, and
  Code Plan subscription launches are refused. A Chat subagent
  follows the same grant-or-refuse rule.
- Octant never reads `.credentials.json` or a Keychain item.
- A launch whose config directory is missing or unsigned-in refuses with
  a step the person can take (`claude auth login` in that directory, or
  store an API key if this is the fallback).
- The Keychain file and `/usr/bin/security` stay denied. Step 0 cannot
  add an exception for either.
- A confined grant follows Step 0's credential/session split. If the
  login is separable, every launch for that thread uses the same
  durable per-thread session directory, and the launch does not
  receive another Project's session files. If it is not, confined
  subscription launches are refused.
- Resume after restart looks up that per-thread session root for
  subscription and API-key threads. The lookup receives the root
  without mutating process-global Claude directory variables.
- Confirmed thread purge deletes that session directory through the
  provider-neutral storage seam, lists the registered receipt on the
  host data map, and has a purge test. A successful purge does not
  leave the Claude transcript on disk.

## Step 3 — Telemetry on subscription launches

On subscription launches of the unmodified binary, stop setting
`DISABLE_TELEMETRY` and `DISABLE_ERROR_REPORTING`. Drop
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` only when every
non-telemetry channel that umbrella also blocks has a dedicated
Octant-set guard or an explicit authorization below.

Anthropic's environment-variable reference (fetched 11 Oct 2026)
documents that the umbrella also blocks release-note, PR/MR badge,
and availability checks; background plugin `command` source runs
(local commands that can trigger dependency installs); and
feature-flag-dependent capabilities including account plugin/skill
sync, Remote Control, advisor, and artifact access.

Authorize as Claude's own traffic, and name them in Step 4: usage
metrics, error reports, session-quality surveys, release-note
checks, PR/MR badge checks, and availability checks.

Keep off with dedicated documented switches, not the umbrella:
`DISABLE_AUTOUPDATER`, `CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL`,
`CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS`, and
`CLAUDE_CODE_DISABLE_AUTO_MEMORY`. `DISABLE_GROWTHBOOK=1` only stops
feature-flag fetching. Anthropic says flags then use their code
defaults, so that switch does not keep Remote Control, advisor,
artifact access, or account plugin/skill sync off if a verified
build defaults those on. Require a dedicated disable switch for
each of those capabilities, or refuse the build when Step 0 cannot
independently disable them. Octant still sets `DISABLE_GROWTHBOOK=1`
so flags stay at code defaults; a host disable-only value of `1` is
already that setting. Do not pass through any other value.

Background plugin `command` runs stay off. If the verified Claude
build documents a dedicated disable switch, set it. If the umbrella
is still the only documented switch, keep
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` and do not drop it only
to re-enable telemetry. Amend 0165 in the same implementation PR
if that measurement keeps the umbrella.

`sanitizeClaudeEnvironment()` copies only `PASSTHROUGH_VARIABLES` today,
so merely dropping names from `REQUIRED_GUARDS` also discards
a user's own disable-only values. Preserve a disable-only setting the
person already exported in the host environment, including the documented
Claude opt-outs `DO_NOT_TRACK`, `DISABLE_GROWTHBOOK=1`, and
`CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1`. Anthropic documents
`DO_NOT_TRACK` as a standard boolean: pass through every disabling
spelling (`1`, `true`, `yes`, `on`, any casing) and reject values that
leave telemetry on (`0`, `false`, `no`, `off`, empty, or unset). Do not
invent an enable flag or pass through any other value.

API-key launches may keep the 0005 telemetry guards.

**Files:**

- `apps/server/src/providers/claudeEnvironment.ts` (`REQUIRED_GUARDS`)
- `apps/server/src/providers/claudeEnvironment.test.ts`
- `apps/server/src/providers/claudeProcess.ts` / its test if they assert
  the subscription guards

**Acceptance:**

- A subscription launch's environment does not contain
  `DISABLE_TELEMETRY` or `DISABLE_ERROR_REPORTING` unless the host
  already set a disable-only value.
- A subscription launch sets `DISABLE_GROWTHBOOK=1` and a dedicated
  documented off switch for Remote Control, advisor, artifact access,
  account plugin/skill sync, and background plugin `command` runs. If
  Step 0 cannot independently disable one of those on the verified
  build, that build is refused or the umbrella stays.
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is absent on a
  subscription launch only when those dedicated guards cover every
  non-telemetry channel the umbrella blocked; otherwise it stays.
- A host `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING`,
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_GROWTHBOOK=1`,
  or `CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1` disable-only value
  survives sanitization on a subscription launch. A host
  `DO_NOT_TRACK` survives when it is a documented disabling spelling
  (`1`, `true`, `yes`, `on`, any casing) and is dropped when it is a
  documented enabling spelling or any other value.
- An API-key launch still sets the 0005 telemetry guards.
- Tests name each re-enabled channel and each channel that stays off.
  They also cover `DO_NOT_TRACK` disabling spellings and reject
  enabling spellings.

## Step 4 — Docs and Settings copy

The shipped pages currently describe the helper-token path the build
still uses, and they note that 0165 proposes replacing it. When Steps
0–5 land, replace that current-behavior guidance with the
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
- Architecture and the privacy pages name every channel Step 3 newly
  enables on subscription launches (usage metrics, error reports,
  session-quality surveys, release-note checks, PR/MR badge checks,
  and availability checks, including third-party logging or error
  tracking Anthropic documents) and every channel that stays off
  (feature-flag evaluation, Remote Control, advisor, artifact access,
  account plugin/skill sync, and background plugin `command` runs).
  The current "no telemetry" and enumerated-destination promises
  cannot remain after that traffic is allowed.

Do not publish that deprecation in the decision PR. 0165 stays Proposed
until Steps 0–5 land, and the shipped guide must keep describing the
helper token the current build still needs.

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
