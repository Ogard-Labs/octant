# Web search backends and data policy

This topic specification owns where Octant's own `web-search` sends a query:
the ordered list of search backends a person sets up, the data policy that
decides which of them may receive a query, the fallback between them, and how
a provider's own search fits beside them. Architecture owns the tool itself,
its one definition, and its result shape
([Architecture: Web search](../architecture.md#web-search)); the patterns the
harness refuses on a tainted thread stay in
[Search queries on a tainted thread](search-query-taint.md).

Status: designed, not built. Today `web-search` searches one SearXNG endpoint
from Chat settings, and a host with none set has no search of its own.

## Why

A person working under a zero data retention (ZDR) agreement, or inside an EU
data boundary, cannot send a query to a service whose retention or processing
location they have not agreed to. A provider's own search does not solve this
on its own: when this design was written (November 2026), no provider's
built-in web search offered both ZDR and EU processing. Anthropic's search is
ZDR-eligible only in its direct mode and offers no EU processing; OpenAI's
covers ZDR with limits and its EU residency coverage was not confirmed;
Mistral's runs only through its agents interface, which ZDR excludes; search
grounding from Google and Microsoft retains queries outside their data
protection terms. EU processing with no retention is reachable only through a
search service Octant calls itself, under the person's own contract with it.

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
- an API key, held by the host's credential broker in a namespace of its own,
  keyed by the entry's credential reference. The key never enters settings,
  the journal, or a window; changing the entry's address deletes the stored
  key, as a model endpoint's does
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

| Kind      | Index                                  | ZDR offered                   | EU or UK processing offered         |
| --------- | -------------------------------------- | ----------------------------- | ----------------------------------- |
| `searxng` | Metasearch over the engines it enables | Self-hosted: as configured    | Self-hosted: as configured          |
| `staan`   | Its own European index                 | Not published; ask the vendor | Yes (EU company and index)          |
| `mojeek`  | Its own independent index              | By agreement                  | Yes (UK)                            |
| `linkup`  | Its own retrieval index                | By agreement                  | By agreement (EU-pinned processing) |
| `brave`   | Its own index                          | Enterprise agreement          | No                                  |
| `exa`     | Its own index                          | Team setting or agreement     | No                                  |

A statement the table does not support is refused when the entry is saved, with
the reason. A SearXNG instance counts as ZDR or EU only when the person states
it, and Settings warns that the instance passes each query to the engines it
enables, most of which are US services; under an EU policy it should enable
only European indexes. Staan's statements are accepted, because the vendor is
an EU company, but its row says that its retention terms were not published
when this was written.

Kinds are added only with a verified API, a published or quoted price, and
terms that say what the vendor keeps. A kind whose results are an answer rather
than a list of pages does not fit `web-search` and is not added.

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
agent cannot read or change it. Where an organization sets the policy in the
host's managed configuration, Settings shows it locked.

## Fallback

A query goes to the first eligible backend. It moves to the next only when the
backend did not answer: a network error, a timeout (8 seconds each, inside the
turn's own cancellation), a rate limit, or a server error. A refused key also
moves on, and the entry reads Needs key in Settings. An empty result is an
answer and does not move on, so a query reaches no more vendors than it has to.
When every backend fails, the model gets `search-failed`, as it does today.

Fallback never leaves the policy: only eligible entries are in the list it
walks. Under Any, the list may still mix regions; the person orders it.

Each call journals the backend that answered and each one that failed, with
the failure kind, so the person can see where a query went.

## A provider's own search

A provider's built-in search is not a backend behind `web-search`. The provider
runs it inside its own loop, so Octant cannot choose its vendor, fall back, or
see the query before it is sent. It stays the separate `provider-native`
research route in Chat, and a vendor runtime's own web tools in Work and Code
([Architecture: Web search](../architecture.md#web-search)). A turn offers one
search: never `web-search` beside a provider's own.

The data policy governs it too:

- Under Any, a provider's own search is used as today.
- Under ZDR only, only a search whose provider makes it ZDR-eligible is used,
  in the eligible mode: for Anthropic's, the direct mode, never dynamic
  filtering. The request builder sets that mode; a provider whose search is
  not ZDR-eligible has it withheld, and the turn uses an eligible backend if
  there is one.
- Under EU only and EU and ZDR, no provider's own search is used until a
  provider documents EU processing for it. Vendor runtimes in Work and Code
  then run with their web tools off.

Each provider's own-search offer (ZDR, EU) is kept beside the provider's
capabilities in `packages/domain` and changes only with the provider's
published terms.

### Outside content

A `web-search` result already marks the thread as having read outside content.
A provider's own search inside the native harness must too: the harness's
stream adapters record each built-in search result (Anthropic's search result
blocks, OpenAI's search calls and their cited URLs) as outside content before
the model's next turn, with the provider and the cited URLs as its source.
Anthropic returns page text encrypted, so the Watcher can read only the titles,
URLs, and cited text; the journal entry says so. The mark is set on any
successful built-in search, whatever the Watcher finds.

## Settings

Settings › Web search shows:

- the data policy, as a choice of the four policies;
- the backend list, reorderable, each row with its kind, region, the two
  statements, and its state (Ready, Needs key, Not eligible under this policy
  with the reason);
- Add backend, which asks for the kind, then the address, key, region, and
  statements the kind takes;
- whether a provider's own search may be used, with the policy's limit on it
  shown beside the switch.

Settings › Chat keeps research routing; its SearXNG address field moves here as
the first backend entry.

## Migration

A stored `searxngBaseUrl` becomes one `searxng` entry, with no statements made
and the policy set to Any, so a host that searched before searches the same
way after. A host with no SearXNG address gets an empty list.

## Delivery

Each slice lands on its own and keeps today's behavior until the next one:

1. Settings contract, the eligibility policy, and the migration; `web-search`
   reads the list, holding only SearXNG.
2. The credential broker namespace for search keys, and the Staan, Mojeek,
   Linkup, Brave, and Exa backends with fallback and the journaled answer.
3. Settings › Web search.
4. The policy applied to a provider's own search, and the native harness's
   outside-content marks for it.

## Open questions

- Staan's retention terms, hosting location, price, and whether it agrees to
  keep no record of queries.
- Which search vendor sees a query through Anthropic's search, and where it
  runs under Anthropic's processing-location settings.
- Whether OpenAI's EU data residency covers its web search.
- Whether a local cache of results is allowed under a vendor's terms (one
  vendor's starter terms limit caching to an hour); this design adds none.
