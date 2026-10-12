# Claude inside Anthropic's terms

Remediation for the proposed Claude-inside-Anthropic's-terms rule in
[architecture](../architecture.md#security-and-authority). The decision
archive closed at 0164, so that rule lives in the owning specification
rather than a numbered record. This plan is product work, not legal
advice. It does not authorize merging.

Helper-token removal and the confined Keychain sign-in land in PR 1142.
Step 0 is measured and decided below. What remains is the terms-rule
acceptance and the leftover session-root and telemetry steps. This
document does not re-open a helper-token path.

## Goal

Octant never collects, stores, scrapes, or forwards Claude.ai OAuth or
setup tokens. The person signs in through the unmodified `claude` binary.
Confined Plan and subagent launches keep that same sign-in: on macOS
through the Keychain read Step 0 measured, on Linux through the login
file in the account directory. Several accounts use the same mechanism,
one Claude-owned directory each (PR 1142).

## Step 0 — macOS login storage, measured and decided

Anthropic's Authentication page (fetched 10 Oct 2026) says:

- On macOS, credentials are stored in the encrypted macOS Keychain.
- When the Keychain rejects the write, Claude Code stores the login in
  `~/.claude/.credentials.json` with mode `0600`.
- If `CLAUDE_CONFIG_DIR` is set, Claude Code keeps `.credentials.json`
  under that directory, including the macOS fallback file, and keys the
  Keychain entry to that directory.

Checked against that page on 12 Oct 2026: it states all three points, and
that Linux keeps the login in `~/.claude/.credentials.json` with mode `0600`.
Linux therefore has no Keychain step, and a rule that refuses a confined
launch whenever that file exists would refuse every Linux subscription Plan
turn.

### Measured on 12 Oct 2026

macOS 27.0.1 (26A434) on Apple Silicon, Claude Code 2.1.296, signed in
with a claude.ai subscription on the default account (`CLAUDE_CONFIG_DIR`
unset). `~/.claude` holds no `.credentials.json`, so the login is in the
Keychain only.

The command was `claude auth status --json` in the environment Octant
gives the implicit first account, run once unconfined and once through
the Plan launch path of PR 1142 (`makeClaudeProcessLive().spawn` with
`executionPolicy: "plan"`). The same profile was then rebuilt with extra
rules. Only `loggedIn` and exit codes were read; `security` ran without
`-w` and its output was discarded.

| Rules added to the Plan profile                                            | `security` finds the item | `claude` signed in |
| -------------------------------------------------------------------------- | ------------------------- | ------------------ |
| Unconfined                                                                 | yes                       | yes                |
| PR 1142 as first written: exec `/usr/bin/security`, two lookups            | no (exit 44)              | no                 |
| The above, read `~/Library/Keychains`                                      | yes                       | no                 |
| The above, `process-fork`                                                  | not rerun                 | yes                |
| PR 1142, `process-fork`, read only `~/Library/Keychains/login.keychain-db` | not run                   | yes                |
| The row above without the two security-server lookups                      | not run                   | no                 |
| Read and write `~/Library/Keychains`, exec `/bin/sh`, no `process-fork`    | not run                   | no                 |
| Exec `/bin/sh`, `process-fork`, read Keychains, no exec of `security`      | not run                   | no                 |
| Exec `/usr/bin/security`, exec `/bin/sh`, `process-fork`, Keychain denied  | not run                   | no                 |

What this settles:

- The carve-out as PR 1142 first wrote it left the binary signed out on
  every confined launch, while the unconfined readiness probe reported
  the account signed in.
- The cause: `security` runs but cannot open the login keychain, and the
  runtime cannot start a child without `process-fork`.
- The smallest set that signs in is exec of `/usr/bin/security`,
  `process-fork`, read of the one file
  `~/Library/Keychains/login.keychain-db`, and the two security-server
  lookups. No shell, no Keychain write, and no other file in that folder
  is needed.
- On this build `CLAUDE_SECURESTORAGE_CONFIG_DIR` names the directory
  that keys the Keychain entry and holds the fallback file.
  When it is unset, `CLAUDE_CONFIG_DIR` does. The entry is
  `Claude Code-credentials`, with a suffix taken from a hash of that
  directory string whenever a directory is named. Read from the build,
  not measured: the string is hashed as given apart from Unicode
  normalization, so a trailing slash would name a different entry.
- The two variables can keep the login apart from session history, but
  on macOS that login is not opaque. A confined read needs the Keychain
  file.

### Decided on 12 Oct 2026

By the rules this plan first set, the measurement meant "refuse confined
subscription launches" on macOS. The maintainer chose instead to relax
the Keychain-file denial on purpose. PR 1142 builds that:

- A subscription launch on macOS takes exactly the smallest set above.
  An API-key launch takes none of it. Nothing else in the Keychain
  folder is readable, and no shell can run.
- The driver refuses a file tool that names the Keychain folder, so the
  grant serves the runtime's own sign-in read and not the model.
- Before a confined launch starts, `claude auth status` runs inside that
  launch's sandbox. A sign-in the sandbox cannot read refuses the turn
  with the step that fixes it. This replaces an attested version range:
  it measures the installed binary on every confined start, so a build
  that stops signing in refuses the turn instead of failing inside it.
- The cost is recorded in the architecture and the threat model. The
  confined runtime may fork, may run `security`, which returns any
  keychain item that trusts that tool, and may read the encrypted login
  keychain file.
- The account directory stays the launch's read and write root. A rule
  that refuses a directory holding `.credentials.json` was considered and
  not adopted, because on Linux that file is the login.

Evidence after the change, on the same machine:

- The in-sandbox sign-in check reports signed in.
- From inside the sandbox, the login keychain file is readable and
  `security` runs. Another keychain file, the folder listing, the system
  keychain, `~/.ssh`, `sh`, `bash`, `zsh`, `curl`, and a write to the
  checkout are all refused. An API-key launch is refused the keychain
  file and `security` as well.
- The real-provider subscription smoke passes its probe, Plan, decline,
  accept, and question stages. Its interrupt stage fails after the
  interrupt with "Claude returned an unsupported runtime message", which
  is a separate defect, and its resume stage was not reached.

Still not measured: an extra assigned account with its own login, and
Linux.

To measure again, run `claude auth status --json` in the environment
`sanitizeClaudeEnvironment("subscription", …)` builds, once directly and
once through `makeClaudeProcessLive().probeSubscription` with a Plan
confinement. Use a clean environment: the desktop app's own `CLAUDE_CODE_*`
variables make the CLI look signed out.

## Step 1 — Remove Connect Claude for helpers (lands in PR 1142)

Done in the 1142 rebuild: Octant no longer mints, stores, or injects a
helper token. Sign-in is the unmodified CLI command in the assigned
account directory. The remaining work below is the upgrade cleanup
already shipped there and the leftover terms-rule steps.

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

Status on 12 Oct 2026: the grant rules this step first set were not
adopted. Step 0's decision replaces them. A confined launch holds the
account directory as its read and write root, and on macOS takes the
measured Keychain sign-in set. What stays open here is the durable
per-thread session directory: nothing below is built, and it is still
the way to keep one Project's transcripts out of another Project's Plan
turn on the same account.

Each Claude account (the default account first) has a Claude-owned
config directory. When login and session history cannot be
separated, or the only confined login is a granted
`.credentials.json` directory, a confined Plan or subagent launch
is refused, and unconfined turns may still set `CLAUDE_CONFIG_DIR`
and, when needed, `CLAUDE_SECURESTORAGE_CONFIG_DIR` to that account
directory. On macOS the confinement builder grants a subscription
launch the Keychain sign-in set Step 0 measured and nothing beyond
it. That read never exposes the token to Octant.

If Step 0 showed the login can live in an opaque credential-only
path distinct from session history, set `CLAUDE_CONFIG_DIR` to the
durable per-thread session root on every launch for that thread,
confined or not. Point only the measured secure-storage variable
(`CLAUDE_SECURESTORAGE_CONFIG_DIR` if that is the credential-only
path Step 0 recorded) at the account credential directory. Grant
the per-thread session root and the launch's temporary directory.
Do not grant a directory that contains `.credentials.json` as a
read root or write root: confinement passes those state directories
as `readRoots` and `additionalWriteRoots`, so Claude file tools
could read or overwrite the OAuth token even though Octant never
opens it. Keychain access stays at the set Step 0 measured.
If the only confined login is that filesystem-backed file, refuse
confined Chat, Work Plan, and Code Plan. That is not the
instance-wide API-key fallback. Anthropic
documents `CLAUDE_CONFIG_DIR` as the session-history store, so
leaving both variables on the account tree while also granting a
per-thread directory still writes and reads account-wide history.
A later Plan or ordinary turn has to find the same session files;
mixing the per-thread root with the account root makes the saved
cursor `stale-resume`. Do not use a throwaway
per-launch config directory: resume has to find the same session
files after a restart. That session directory is thread-owned. The
host allocates it beneath a host-owned, provider/thread-scoped
root. The driver does not choose or register an arbitrary
filesystem path: a receipt that named `/`, home, or a checkout
would otherwise turn confirmed purge into an arbitrary delete. If
the driver later reports a nested path, the host canonicalizes it
and refuses anything outside that allocated root. Cover the
refusal with a rejection test.

The host commits a thread-bound receipt before the first session
write. That receipt is journaled host data, reloadable after a
restart and while the provider is disabled. Confirmed purge
deletes only the allocated location from the receipt. A
third-party driver has no way to register thread-owned storage
today, so do not add a Claude-only path to `hostDataMap` or the
purge sweep. First add a provider-neutral storage/lifecycle seam
on `@octant/provider-sdk`: the host allocates the root and issues
the receipt; the host data map and purge sweep only see those
host-issued receipts. Claude consumes that seam. Report deletion
or failure, and cover purge after restart with the provider
disabled. Leaving the transcript on disk after a successful purge
is a privacy defect.

Resume lookup must use that same per-thread root. `findSession`
today calls `listSessions` against the project
directory and the server's default Claude store unless it receives
the launch session root. Pass that root into the lookup without
mutating process-global environment: threads can resume concurrently.
A root-aware lookup is still not enough for ordinary Chat, Work,
or Code resume after restart. `ClaudeResumeIdentityStore` keeps
identities in a process-lifetime `Map` and clears them on close.
The driver returns `stale-resume` before calling `findSession`
when that identity is missing. Persist the ordinary resume
identity the same way the agent-run child provider identity
already is: journaled host data, reloadable after restart, and
deleted with confirmed thread purge. Cover that persistence in
the restart-resume test. Cover restart resume for subscription
and API-key roots. Threads that already started under the helper-
token path, and ordinary threads started on an unattested binary,
still have their history in the account config tree. Persist that
chosen root with the thread so a later Plan switch can see it. Do
not relocate those threads into an empty per-thread directory: that
makes the saved cursor `stale-resume`. Unconfined later launches may
keep that account session root. Existing confined Chat or Plan
threads, and any later confined switch of an account-root thread
started on an unattested build, cannot keep it: granting the
account tree on the next confined launch would expose another
Project's transcripts. Those threads take an explicit new-thread
transition before the next confined subscription launch.

Do not grant the shared session tree to a confined Chat subagent or
Plan turn that would otherwise read another Project's history. If
the login is inseparable from the account config tree, or only
works by granting a `.credentials.json` directory, refuse
confined subscription launches (Chat, Work Plan, and Code Plan).
Unconfined turns may still use the CLI login. Do not invent a split
the unmodified binary does not support, and do not switch the whole
instance to an API key only because confined launches cannot share
history or cannot receive a credential file.

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
- `apps/server/src/providers/claudeResumeIdentityStore.ts`
- `apps/server/src/providers/claudeAgentSdkPort.ts` (`findSession`)
- `@octant/provider-sdk` thread-owned storage/lifecycle seam, then the
  host allocation root, durable receipt, and purge sweep that consume
  host-issued receipts
- `apps/server/src/process/seatbeltProfile.ts` and the Linux builder
- Settings copy that today asks the person to Connect Claude for helpers
- `docs/architecture.md` (0145 / confined Claude launch)

**Acceptance:**

- A confined Plan turn on a subscription instance signs in without
  `CLAUDE_CODE_OAUTH_TOKEN` in the launch environment: through the
  measured Keychain set on macOS, and through the login file in the
  account directory on Linux. A sign-in the sandbox cannot read
  refuses the turn before it starts. A Chat subagent follows the
  same rule.
- Octant never reads `.credentials.json` or a Keychain item.
- A launch whose config directory is missing or unsigned-in refuses with
  a step the person can take (`claude auth login` in that directory, or
  store an API key if this is the fallback).
- Keychain access is exactly the set Step 0 measured: exec of
  `/usr/bin/security`, `process-fork`, read of `login.keychain-db`,
  and the two security-server lookups. No other file in that folder
  and no shell.
- A confined grant follows Step 0's credential/session split. If the
  login is separable and opaque, every launch for that thread sets
  `CLAUDE_CONFIG_DIR` to the same durable per-thread session
  directory and points only the measured secure-storage variable at
  the credential-only path. The launch does not receive another
  Project's session files and does not receive a `.credentials.json`
  directory as a read or write root. If login is inseparable or
  only filesystem-backed, confined subscription launches are
  refused.
- Resume after restart looks up that per-thread session root for
  subscription and API-key threads. The lookup receives the root
  without mutating process-global Claude directory variables. The
  ordinary Chat, Work, and Code resume identity is journaled and
  purgeable, not process-lifetime only.
- The thread records the session root it actually used. An
  account-root thread started on an unattested binary takes the
  same new-thread transition before a later confined subscription
  launch.
- Confirmed thread purge deletes that host-allocated session
  directory through the provider-neutral storage seam. The host
  issued the receipt before the first session write, lists it on
  the host data map after restart and while the provider is
  disabled, refuses a path outside the allocated root, and has a
  purge-after-restart test. A successful purge does not leave the
  Claude transcript on disk.

## Step 3 — Telemetry on subscription launches

On subscription launches of the unmodified binary, stop setting
`DISABLE_TELEMETRY` and `DISABLE_ERROR_REPORTING`. Drop
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` only when every
non-telemetry channel that umbrella also blocks has a dedicated
Octant-set guard or an explicit authorization below.

Anthropic's environment-variable reference (fetched 11 Oct 2026)
documents that the umbrella also blocks release-note, PR/MR badge,
and availability checks; `/feedback`, `/bug`, `/share`, and
Claude-drafted feedback; background plugin `command` source runs
(local commands that can trigger dependency installs); and
feature-flag-dependent capabilities including account plugin/skill
sync, Remote Control, advisor, and artifact access.

Authorize as Claude's own traffic, and name them in Step 4: usage
metrics, error reports, session-quality surveys, release-note
checks, PR/MR badge checks, and availability checks.

Keep off with dedicated documented switches, not the umbrella:
`DISABLE_AUTOUPDATER`, `CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL`,
`CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS`,
`CLAUDE_CODE_DISABLE_AUTO_MEMORY`, and `DISABLE_BUG_COMMAND`.
`/feedback`, `/share`, and Claude-drafted feedback stay off the
same way: they can upload conversation history and code. Keep
`DISABLE_BUG_COMMAND=1` and a dedicated documented off switch for
each of those feedback channels. If Step 0 cannot independently
disable one of them, keep the umbrella. `DISABLE_GROWTHBOOK=1` only stops
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
to re-enable telemetry. Amend the architecture rule in the same
implementation PR if that measurement keeps the umbrella.

`sanitizeClaudeEnvironment()` copies only `PASSTHROUGH_VARIABLES` today,
so merely dropping names from `REQUIRED_GUARDS` also discards
a user's own disable-only values. Preserve a disable-only setting the
person already exported in the host environment, including the documented
Claude opt-outs `DO_NOT_TRACK`, `DISABLE_GROWTHBOOK=1`, and
`CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY`. Anthropic documents
`DO_NOT_TRACK` and `CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY` as standard
booleans: pass through every disabling spelling (`1`, `true`, `yes`,
`on`, any casing) and reject values that leave telemetry or surveys on
(`0`, `false`, `no`, `off`, empty, or unset). Do not invent an enable
flag or pass through any other value.

When Step 2 points `CLAUDE_CONFIG_DIR` at a new per-thread session
root, Claude reads `settings.json` from that root. Anthropic
documents that environment variables may live under `settings.json`.
An account-level disable-only value in the account `settings.json`
would otherwise disappear when the config directory relocates.
Seed validated disable-only settings into the thread root: read
only that account `settings.json`, never `.credentials.json` or
another credential file; copy only the same disable-only names
and spellings this step already preserves from the host
environment; write those into the thread root's `settings.json`.
Do not copy credentials, session files, unknown keys, or values
that leave telemetry or surveys on.

API-key launches may keep the 0005 telemetry guards.

**Files:**

- `apps/server/src/providers/claudeEnvironment.ts` (`REQUIRED_GUARDS`)
- `apps/server/src/providers/claudeEnvironment.test.ts`
- `apps/server/src/providers/claudeProcess.ts` / its test if they assert
  the subscription guards
- the per-thread `settings.json` disable-only seeder and its test

**Acceptance:**

- A subscription launch's environment does not contain
  `DISABLE_TELEMETRY` or `DISABLE_ERROR_REPORTING` unless the host
  already set a disable-only value.
- A subscription launch sets `DISABLE_GROWTHBOOK=1` and a dedicated
  documented off switch for Remote Control, advisor, artifact access,
  account plugin/skill sync, background plugin `command` runs,
  `/feedback`, `/bug`, `/share`, and Claude-drafted feedback,
  including `DISABLE_BUG_COMMAND=1`. If Step 0 cannot independently
  disable one of those on the verified build, that build is refused
  or the umbrella stays.
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is absent on a
  subscription launch only when those dedicated guards cover every
  non-telemetry channel the umbrella blocked; otherwise it stays.
- A host `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING`,
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, or
  `DISABLE_GROWTHBOOK=1` disable-only value survives sanitization on a
  subscription launch. A host `DO_NOT_TRACK` or
  `CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY` survives when it is a
  documented disabling spelling (`1`, `true`, `yes`, `on`, any casing)
  and is dropped when it is a documented enabling spelling or any
  other value.
- An account `settings.json` disable-only value for
  `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING`,
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`,
  `DISABLE_GROWTHBOOK=1`, `DO_NOT_TRACK`, or
  `CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY` survives relocation of
  `CLAUDE_CONFIG_DIR` into the per-thread root. Credential files
  are never read. Enable spellings and unknown keys are not copied.
- An API-key launch still sets the 0005 telemetry guards.
- Tests name each re-enabled channel and each channel that stays off.
  They also cover `DO_NOT_TRACK` and
  `CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY` disabling spellings and reject
  enabling spellings.

## Step 4 — Docs and Settings copy

The shipped pages currently describe the helper-token path the build
still uses, and they note that a proposed architecture rule would
replace it. When Steps
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
  account plugin/skill sync, background plugin `command` runs,
  `/feedback`, `/bug`, `/share`, and Claude-drafted feedback).
  The current "no telemetry" and enumerated-destination promises
  cannot remain after that traffic is allowed.

Do not publish that deprecation in this documentation PR. The
architecture rule stays proposed until Steps 0–5 land, and the shipped
guide must keep describing the helper token the current build still
needs.

## Step 5 — Tests that enforce the rule

Add a focused test (and a lint or grep gate if a test alone can be
skipped) that fails if Octant sets `CLAUDE_CODE_OAUTH_TOKEN` from its
own storage.

**Files:**

- `apps/server/src/providers/claudeEnvironment.test.ts`
- `apps/server/src/providers/claudeDriver.test.ts`
- A small repo check next to the existing provider tests, or an
  assertion in `sanitizeClaudeEnvironment` that the variable is absent
  unless it arrived from the host environment for a reason the
  proposed architecture rule does not allow — in practice it must stay
  absent.

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

- Product code in the documentation PR that proposed the architecture
  rule.
- Host-driven Claude subscription OAuth on the native harness or on
  Anthropic-compatible HTTP (refused).
- Reading `~/.claude/.credentials.json` or the Keychain from Octant.
- Changing 0102 local usage history. It already reads bounded local
  transcript files and does not call Anthropic with a subscription
  credential.
