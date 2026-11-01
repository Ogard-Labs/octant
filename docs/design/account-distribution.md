# Account distribution

This topic specification owns the plan for choosing which of a person's
accounts of one provider a new thread starts on, when the person did not pick
one. Architecture owns the boundaries it must keep: provider instances and
accounts ([Providers](../architecture.md#providers)), the Project provider
policy ([Providers](../architecture.md#providers)), and credentials
([Security and authority](../architecture.md#security-and-authority)).

**Status: Designed, not built. Held until the provider terms question is
answered.** The maintainer asked for the plan on 2026-11-01 and asked that
nothing of it be built yet. Nothing below is in force. The current rule in
[Providers](../architecture.md#providers) stays in force unchanged: a thread
stays on the instance it started with, and there is no automatic failover,
rotation, or load-balancing between accounts. No slice of this plan merges
while that rule stands, and changing it is its own maintainer decision.

## What it does

A person with more than one account for a provider (several subscription
logins, several API-key accounts, or both) may set, per provider, how Octant
picks an account for a new thread when the person picked none.

- **Only at a new thread with no account picked.** The setting is read once,
  when a new Chat, Work, or Code thread is created and its first prompt names
  no account. An account the person picks always wins: in the composer's
  picker, in `octant agent --model`, in a routine's saved model, or in a
  handoff that names a target.
- **A running thread never moves.** A provider session lives in its account's
  state directory (its history, resume id, and login), so the thread keeps the
  account it started on for its whole life, as today. Hitting a limit in a
  running thread ends that turn the way it does now; Octant does not resume it
  on another account.
- **Off by default.** With the setting off, a new thread with no account
  picked uses the provider's default account, as today.
- **Per provider.** Each provider has its own setting and its own list of
  accounts taking part. An account is in that list only when the person added
  it.

## Modes

| Mode            | How it picks                                                                                    |
| --------------- | ----------------------------------------------------------------------------------------------- |
| Day of week     | The person maps each weekday to one account, for example work accounts Monday to Friday         |
| Random          | Uniform choice among the accounts that are eligible                                             |
| Weighted        | Random choice in proportion to a weight the person sets on each eligible account                |
| Most limit left | The eligible account whose latest plan-usage reading shows the most of its tightest window left |

"Most limit left" reads only the per-account plan-usage snapshots Octant
already keeps from the provider's own process. It starts no provider process
to ask, calls no vendor usage endpoint, and reads no credential file. An
account whose reading is missing or stale ranks after accounts with a fresh
reading, and the pick says so.

## Eligibility

An account is offered to the pick only when all of these hold:

- it is enabled and its last readiness check was ready (signed in, binary
  compatible);
- its latest plan-usage reading does not show it at a limit, when a reading
  exists;
- the Project's provider policy allows it (all providers, an explicit list,
  or a tag policy); a Project policy still limits what is offered, and the
  pick never widens it;
- its provider's compliance gate is open (below).

When no account is eligible the thread is not started on a guess: the
composer says which accounts were skipped and why, and the person picks.

## What the person sees

- The new thread shows the account it started on and the reason in one line,
  for example "Picked work account: Tuesday" or "Picked personal account: most
  limit left (62% of the weekly window)". Skipped accounts are listed with
  their reason.
- The pick is journaled on the thread as one event with the mode, the
  account chosen, the eligible set, each skipped account with its reason, and
  the plan-usage reading's `observedAt` when the mode used it. No secret,
  token, or credential reference is recorded.

## What differs between accounts

Two accounts of one provider are not interchangeable, and the pick is shown so
the person can tell.

- **Provider-owned state lives in the account folder.** Claude Code keeps its
  skills, settings, hooks, agents, plugins, and session history per account
  directory (`CLAUDE_CONFIG_DIR`); Codex keeps its configuration and history
  per `CODEX_HOME`. A thread started on another account sees that account's
  setup, not the first one's.
- **Octant's own state belongs to the Project.** Project memory, the Project's
  provider policy, its trusted providers, and its threads are Project data and
  are the same whichever account a thread starts on.
- **Plans and data terms differ.** A personal plan, a company plan, and an
  API-key account carry different terms, retention, and billing. The pick
  never mixes in an account the person did not add to the provider's list.

## Compliance gate

Each provider's setting is off and cannot be turned on until that provider's
row below says Allowed for the mode. The row is set by a maintainer change to
this document, citing the provider's own text or a written answer from the
provider. A gate row that says anything other than Allowed keeps the setting
hidden for that provider.

Terms read on 2026-11-01. This is a reading of public pages, not legal
advice; each row marked Unclear needs a written answer from the provider or a
lawyer's review.

| Provider    | Choose per new thread                          | Most limit left, at-limit skip | Gate   |
| ----------- | ---------------------------------------------- | ------------------------------ | ------ |
| Anthropic   | Unclear; leans forbidden when it avoids limits | Unclear, leans forbidden       | Closed |
| OpenAI      | Forbidden when it avoids limits; else unclear  | Forbidden                      | Closed |
| Mistral     | Forbidden: one account per person              | Forbidden                      | Closed |
| OpenCode    | Forbidden when it avoids limits                | Forbidden                      | Closed |
| Every other | Silent or not read in full                     | Silent or not read in full     | Closed |

What the 2026-11-01 reading found:

- **Anthropic.** Claude Code documents staying signed in to several accounts
  at once, such as work and personal, each with its own config directory
  ([Authentication](https://code.claude.com/docs/en/authentication)), so
  holding them is not the open question. The Usage Policy forbids
  intentionally bypassing restrictions established in Anthropic's products,
  and creating multiple accounts to circumvent product guardrails
  ([Usage Policy](https://www.anthropic.com/legal/aup); the page shows
  effective 2026-11-12). Plan usage limits are such a restriction, so a pick
  made to stretch them is the risk, and "most limit left" aims at them
  directly. Advertised Pro, Max, and Ultra limits assume ordinary,
  individual use
  ([Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)).
  Accounts and credentials may not be shared with anyone else
  ([Consumer Terms](https://www.anthropic.com/legal/consumer-terms), effective
  2025-10-08), so only the person's own accounts can take part. API limits
  are set per organization
  ([Rate limits](https://platform.claude.com/docs/en/api/rate-limits)), so
  keys in one organization share one limit.
- **Anthropic, before any of this.** The Agent SDK page says that, unless
  previously approved, third-party developers may not offer claude.ai login or
  rate limits in their products, including agents built on the SDK
  ([Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)).
  Octant's Claude driver is built on the SDK. Whether Octant may offer
  subscription accounts at all is the open item already recorded under
  "Proposed, not accepted: Claude sign-in inside Anthropic's terms" in
  [Security and authority](../architecture.md#security-and-authority), and it
  is answered before the Anthropic row here.
- **OpenAI.** The Sign in with ChatGPT terms bar apps from enabling multiple
  accounts, rotating accounts, or splitting usage to bypass limits, and the
  Terms of Use bar circumventing rate limits
  ([Sign in with ChatGPT terms](https://openai.com/policies/sign-in-with-chatgpt-terms/),
  [Terms of Use](https://openai.com/policies/row-terms-of-use/)). Those pages
  refused automated reads on 2026-11-01, so this rests on search excerpts and
  needs a full read in a browser.
- **Mistral.** The consumer terms forbid one person creating or using more
  than one Mistral account
  ([Consumer terms](https://legal.mistral.ai/terms/row-consumer-terms/),
  effective 2026-10-12). Mistral never takes part.
- **OpenCode.** The terms bar multiple accounts used to get around usage
  limits ([Terms](https://opencode.ai/legal/terms-of-service), search excerpt).
- **Others** (Google, GitHub Copilot, xAI, Moonshot, Z.ai, Alibaba,
  Cognition, OpenRouter): no text found that addresses a tool choosing among
  one person's accounts. Several forbid account sharing, and Z.ai and Alibaba
  limit plans to supported tools or interactive use. Silence is not
  permission; each needs its own written answer before its row opens.

## Slices, once a gate opens

1. Contracts: the per-provider setting, the account list with weights and the
   weekday map, and the journal event, with the gate table as data.
2. Pick at new-thread creation on the host, for the open providers only, with
   the eligibility checks and the journal event.
3. Composer and Settings surfaces: the setting, the picked-account line, and
   the skipped list.

Each slice states its own acceptance checks. None starts before a gate row
says Allowed and the maintainer lifts the no-rotation rule for that provider.
