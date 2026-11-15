# Web search backends and data policy

This topic specification owns where a web search query goes: the ordered list
of search backends a person sets up for Octant's own `web-search`, the data
policy that decides which of them may receive a query, the fallback between
them, and a provider's own built-in search, both in the native harness and in a
vendor runtime, under that same policy. Architecture owns the tool itself, its
one definition, and its result shape
([Architecture: Web search](../architecture.md#web-search)); the patterns the
harness refuses on a tainted thread stay in
[Search queries on a tainted thread](search-query-taint.md).

Status: partly built. Built: the settings contract and its journaled
`/api/host-control/web-search` route, the eligibility policy, the research
route's "Octant web search" label, and the migration; `web-search` searches the first
eligible backend, and the only kind so far is `searxng`. Not built: the vendor
backends, their credential broker namespace and the fallback (slice 2),
Settings › Web search (slice 3), and a provider's own search in the native
harness (slice 4), which still refuses any built-in tool a provider starts in
its stream as `unsupported`, so a harness endpoint reports
`nativeWebResearch` as `unsupported`.

## Why

A person working under a zero data retention (ZDR) agreement, or inside an EU
data boundary, cannot send a query to a service whose retention or processing
location they have not agreed to. A provider's own search does not solve this
on its own: when this design was written (November 2026), no provider's
built-in web search offered both ZDR and EU processing. Anthropic's search is
ZDR-eligible only in its basic mode and offers no EU processing; OpenAI's
covers ZDR with limits and its EU residency coverage was not confirmed;
Mistral's runs only through its agents interface, which ZDR excludes; search
grounding from Google and Microsoft retains queries outside their data
protection terms. EU processing with no retention is reachable only through a
search service Octant calls itself, under the person's own contract with it.
A provider's own search is still the simplest search for a person who has only
a model endpoint, so the native harness offers it where the policy allows.

## The tool stays one tool

The `web-search` name, argument schema, and `{ query, results: [{ title, url,
snippet }] }` result do not change, and the definition never names a backend:
it is part of the stable prefix every turn sends, and a model should not learn
which vendor answered. Which backend answered is journaled with the call, for
the person, not returned to the model.

## Backends

A person keeps an ordered list of backends in Settings › Web search. Each entry
has:

- a kind, from the list below;
- an address, where the kind has more than one (a SearXNG instance, a vendor's
  regional host);
- an API key, held by the host's credential broker in a namespace of its own
  (`/v1/web-search-credentials/*`), keyed by the entry's credential reference.
  The key never enters settings, the journal, or a window; changing the
  entry's address deletes the stored key, as a model endpoint's does
  ([Providers and model endpoints](model-endpoints.md#endpoint-address-and-stored-key));
- the processing region the person chose, where the vendor offers a choice;
- two statements the person makes about their own agreement with the vendor:
  "This vendor keeps no record of my queries" (ZDR) and "This vendor processes
  my queries only in the EU or UK" (EU processing). Octant cannot read a
  contract, so it relies on the person's statement, and accepts a statement
  only for a kind whose vendor offers it (below).

The address follows the endpoint rule Octant already applies to SearXNG: HTTPS,
or plain HTTP only on a loopback address, with no credentials, query, or
fragment.

### Kinds and what each vendor offers

| Kind      | Index                                  | ZDR offered                | EU or UK processing offered         |
| --------- | -------------------------------------- | -------------------------- | ----------------------------------- |
| `searxng` | Metasearch over the engines it enables | Self-hosted: as configured | Self-hosted: as configured          |
| `staan`   | Its own European index                 | Not published              | Yes (EU company and index)          |
| `mojeek`  | Its own independent index              | By agreement               | Yes (UK)                            |
| `linkup`  | Its own retrieval index                | By agreement               | By agreement (EU-pinned processing) |
| `brave`   | Its own index                          | Enterprise agreement       | No                                  |
| `exa`     | Its own index                          | Team setting or agreement  | No                                  |

A statement the table does not support is refused when the entry is saved, with
the reason. Staan's ZDR statement is refused until the vendor publishes
retention terms; its EU statement is accepted. A SearXNG instance counts as ZDR
or EU only when the person states it, and Settings warns that the instance
passes each query to the engines it enables, most of which are US services;
under an EU policy it should enable only European indexes.

The table is data in `packages/domain`, and each kind's entry carries the date
its terms were checked and the published source it was read from; it changes
only when that source does. Kinds are added only with a verified API, a
published or quoted price, and terms that say what the vendor keeps. A kind
whose results are an answer rather than a list of pages does not fit
`web-search` and is not added.

## Data policy

Settings › Web search sets one data policy for the host:

| Policy     | A backend may receive a query when                |
| ---------- | ------------------------------------------------- |
| Any        | it is enabled                                     |
| ZDR only   | it is enabled and the person stated ZDR           |
| EU only    | it is enabled and the person stated EU processing |
| EU and ZDR | it is enabled and the person stated both          |

Eligibility is a pure policy in `packages/domain`: it takes the list, the
policy, and each kind's offer, and returns the eligible entries in the
person's order. With no eligible entry, `web-search` is not offered at all,
the rule SearXNG follows today: no request leaves the host without a backend
the person set up.

The policy is the host's, not a thread's: a thread cannot loosen it, and an
agent cannot read or change it. The policy, the list, and the statements change
only through a settings command that a local window or a device the host's own
person paired sends, the rule that already governs a provider's native setup
([Architecture: providers](../architecture.md#providers)), and each change is
journaled. A policy set by an organization for its people's hosts is outside
the [Current Release Boundary](../architecture.md#current-release-boundary),
with the other enterprise controls it defers.

## Fallback

A query goes to the first eligible backend. It moves to the next only when the
backend did not answer: a network error, a timeout, a rate limit, or a server
error. A refused key also moves on, and the entry reads Needs key in Settings.
An empty result is an answer and does not move on, so a query reaches no more
vendors than it has to. When every backend fails, the model gets
`search-failed`, as it does today.

One call has a 20-second budget inside the turn's own cancellation. Each
backend gets the time left in it, at most 15 seconds, today's SearXNG timeout;
a backend the budget does not reach is journaled as not tried. Rationale: a
per-backend timeout alone lets three slow backends hold a turn for most of a
minute, and the turn runner's inactivity window is the wrong place to learn
that.

Fallback never leaves the policy: only eligible entries are in the list it
walks. Under Any, the list may still mix regions; the person orders it.

Each call journals the backend that answered and each one that failed, with
the failure kind, so the person can see where a query went.

## Research route

Chat's research route keeps its three values. The `searxng` value now means
Octant's own `web-search` over the backend list, whatever the backends are, so
the UI labels it "Octant web search"; the value itself stays `searxng` on the
wire and in storage, as a citation's `backend` does, so stored threads and
settings and an older client read it unchanged. Rationale: renaming the value
would need a decoder for the old one and would break a mobile client that
predates it, for no gain the label does not already give.

- `searxng` (Octant web search) offers `web-search` when an eligible backend
  exists.
- `provider-native` offers the provider's own search when the provider supports
  it and the policy allows it (below).
- `automatic` keeps the order Architecture's Web search section gives
  between the two, counting a route as ready only when the policy allows it.
  A person who wants their own backends ahead of a provider's search chooses
  Octant web search.

A native harness thread in Work and Code follows `automatic`. A turn offers
one search, never `web-search` beside a provider's own. Under a policy that
withholds the provider's own search, `provider-native` reads unavailable with
that reason, as it does today for a provider without one. The route's
existing control in Settings › Chat and on a thread stays the only place it is
chosen: the policy limits the route; it adds no second switch.

## A provider's own search

A provider's built-in search runs inside the provider's own loop, so Octant
cannot choose its vendor, fall back, or see the query before it is sent. That
decides two rules: the data policy withholds it wherever Octant cannot hold the
provider to the policy, and the tainted-thread rule withholds it wherever
Octant cannot refuse a query.

### What each provider offers

| Provider search                                  | ZDR offered                                 | EU processing offered |
| ------------------------------------------------ | ------------------------------------------- | --------------------- |
| Anthropic API, basic web search                  | Yes, under the person's ZDR agreement       | No                    |
| Anthropic API, web search with dynamic filtering | No                                          | No                    |
| OpenAI API (Responses), web search               | With limits, under the person's ZDR terms   | Not confirmed         |
| Any other origin or protocol                     | Not offered: Octant cannot tell who runs it | Not offered           |

This table is data beside the provider capabilities in `packages/domain`, with
the same checked date and source as the backend table. The person states ZDR
for a provider's search on its model endpoint, as for a backend, and the
statement is accepted only where the table offers it.

The data policy applies:

- Under Any, a provider's own search is used where the route selects it.
- Under ZDR only, it is used only where the table offers ZDR and the person
  stated it, and only in the eligible mode: Anthropic's basic web search,
  never the version with dynamic filtering. The request builder sets that
  version.
- Under EU only and EU and ZDR, no provider's own search is used until a
  provider documents EU processing for it.

### In the native harness

The native harness offers a provider's own search on two origins only:

- an `anthropic-compatible` endpoint whose address is Anthropic's own API,
  as Anthropic's basic web search server tool;
- an `openai-compatible` endpoint whose address is OpenAI's own API on the
  Responses protocol, as the Responses web search tool.

A gateway, Azure AI Foundry, Ollama, a sign-in endpoint, and the Chat
Completions protocol keep `nativeWebResearch` as `unsupported`: a gateway may
pass the tool through, but Octant cannot tell which search vendor runs the
query or under which terms. The probe reports `supported` on the two origins
above and Architecture's capability table records it once built.

**One search per request.** The request caps the provider's built-in search at
one call: Anthropic's `max_uses: 1`, and the Responses `max_tool_calls: 1`,
which caps built-in tool calls across a response and leaves function calls
alone (OpenAI's SDK types, checked November 2026). The
stream adapter enforces the same cap itself: a second built-in search in one
response fails that step as `unsupported`, as any built-in tool does today, so
a provider that ignores the cap cannot search again on what it just read. Every
built-in tool other than web search stays refused.

**Tainted threads.** Below Full access, a thread that has read outside content
is not offered the provider's own search: the next request leaves the built-in
tool out and offers `web-search` when an eligible backend exists, where the
tool-call policy can refuse a query that looks like it carries data
([Search queries on a tainted thread](search-query-taint.md)). With no eligible
backend, a tainted thread has no search, and the turn's search status says so.
At Full access the provider's own search stays offered and the mark is only
recorded, as the tainted-query rule does there. Rationale: Octant sees a
built-in query only after the provider has sent it, so the refusal the
tainted-query rule promises can hold only by not offering the tool; the one
request whose tool list changes, at the moment the thread first reads outside
content, costs one prompt cache miss, which is the price of keeping the rule.

**Outside content.** Every successful built-in search marks the thread as
having read outside content before the model's next step, whatever the Watcher
finds, with the provider and the cited URLs as its source. The stream adapters
read Anthropic's `server_tool_use` and `web_search_tool_result` blocks and
OpenAI's `web_search_call` items with their sources and URL citations. Anthropic
returns page text encrypted, so the Watcher reads only the titles, URLs, and
cited text, and the journal entry says so.

**Journal and usage.** The call is journaled as a `web-search` activity with the
query the provider reports, after the fact, the provider as the backend, and
the result URLs. Each search's count, and its price where the provider reports
or publishes one, joins the turn's usage and cost
([Architecture: context and usage accounting](../architecture.md#context-and-usage-accounting)).

### In a vendor runtime

A vendor runtime's own web tools in Work and Code (Claude Code's, Codex's,
OpenCode's, and an ACP agent's) are its native setup's `webTools`, which the
person already turns on per account
([Architecture: providers](../architecture.md#providers)). Octant cannot set
which search mode a vendor runtime uses, so the policy limits that switch:

- Under Any, `webTools` follows the native-setup policy
  ([Provider runtimes](provider-runtimes.md)), as today.
- Under any other policy, `webTools` is off, and Settings › Providers shows the
  switch locked with the policy as its reason. Its journaled value does not
  change, so returning to Any restores the person's choice.

These tools already mark the thread as having read outside content.

## Settings

Settings › Web search is a page in the Tools group, after Skills &
Extensions ([Settings](settings.md#groups-and-pages)). It shows:

- the data policy, as a choice of the four policies;
- the backend list, reorderable, each row with its kind, region, the two
  statements, and its state (Ready, Needs key, Not eligible under this policy
  with the reason);
- Add backend, which asks for the kind, then the address, key, region, and
  statements the kind takes;
- what the policy allows of a provider's own search, with a link to the
  research route in Settings › Chat and to the locked `webTools` switches.

A model endpoint's page in Octant Harness gains the ZDR statement for its
provider's own search, where the provider offers it. Settings › Chat keeps the
research route; its SearXNG address field moves here as the first backend
entry, and a link to the old field opens this page.

## Migration

A stored `searxngBaseUrl` becomes one `searxng` entry, with no statements made
and the policy set to Any, so a host that searched before searches the same
way after. The host reads that entry from Chat settings until the person first
saves a list; the save journals the migrated list as the change's previous
value, and from then on the saved list alone decides. A host with no SearXNG address gets an empty list. A stored research
route of `searxng`, on a thread or as Chat's default, keeps its value and now
searches the backend list.

## Delivery

The four slices together are one delivery: the feature is not done until all
four land. Each slice lands on its own and keeps today's behavior until the
next one:

1. Settings contract, the eligibility policy, the research route's "Octant web search" label, and
   the migration; `web-search` reads the list, holding only SearXNG.
2. The credential broker namespace for search keys, and the Staan, Mojeek,
   Linkup, Brave, and Exa backends with the fallback budget and the journaled
   answer.
3. Settings › Web search, the endpoint ZDR statement, and the policy's lock
   on vendor runtimes' `webTools`.
4. A provider's own search in the native harness: the Anthropic and OpenAI
   request builders, the one-search cap and its stream enforcement, the
   tainted-thread withholding, the outside-content marks, journal, and usage,
   and the policy applied to it. Its acceptance includes a live search on each
   of the two origins.

## Open questions

- Staan's retention terms, hosting location, price, and whether it agrees to
  keep no record of queries.
- Which search vendor sees a query through Anthropic's search, and where it
  runs under Anthropic's processing-location settings.
- Whether OpenAI's EU data residency covers its web search, and which limits
  its ZDR terms place on it.
- Whether a local cache of results is allowed under a vendor's terms (one
  vendor's starter terms limit caching to an hour); this design adds none.
