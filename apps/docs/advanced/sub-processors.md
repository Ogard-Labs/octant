---
description: Draft sub-processor position — for BYO-key and BYO-subscription use, AI providers process data under the user's own contract, not Octant's.
---

# Sub-processors

::: warning Draft pending legal review
This page is a draft legal position grounded in current product behavior. It
is **not** published, is **not** a data processing agreement, and is **not**
a list of Octant sub-processors certified by counsel.
:::

## The position

For bring-your-own-key and bring-your-own-subscription use, the AI
providers you configure are **your** processors. They are not Octant's
sub-processors.

Octant is local-first software running on a host you control. A Chat, Work,
or Code turn is sent from that host to the endpoint or runtime you added.
There is no Octant account, no Octant-operated model API, and no Octant
proxy that receives the prompt, the transcript, or the provider's reply in
order to forward it.

That is the technical fact this position rests on. Counsel still has to
decide how to state it in a published notice.

## Bring-your-own key

You create a provider instance and supply an API key. Octant stores that
key as a write-only reference in the macOS Keychain and resolves it through
the desktop broker at call time. The key never enters the event journal,
the renderer, diagnostics, or a thread export.

The HTTP request then leaves **your** machine for **your** endpoint — an
OpenAI-compatible, Anthropic-compatible, Azure AI Foundry, or similar
URL you named. The contract for that processing is the one between you and
that provider, not a contract between that provider and Ogard Labs.

Connection Check probes readiness without sending a prompt.

## Bring-your-own subscription

Where a provider runtime supports OAuth or subscription login, Octant
delegates that login to the provider's own CLI or SDK. Octant never
stores, refreshes, or journals those tokens. Auto-registration of a
detected local runtime never enables the provider, never stores
credentials, and never logs in.

The session that follows still runs on your host against that provider's
runtime. The provider remains a party you brought, not a party Octant
engaged on your behalf.

## What Octant is not, for this traffic

- Octant does not host your journal or your threads.
- Octant does not sit on the network path between your host and the
  provider as a required relay.
- Octant does not receive a copy of prompts or completions for training,
  analytics, or support.
- A core capability never requires a specific vendor. Disabling or
  removing a provider instance stops new sessions with that instance; it
  does not delete historical thread references until you purge them.

Local and loopback providers (for example Ollama on loopback) never leave
the machine at all.

## Traffic that is not a provider turn

The position above covers BYO provider inference. Other requests Octant
makes on its own, or because you asked, are different relationships:

- **Update checks** go to the feed host
  (`https://octant.sh/updates/darwin-arm64.json` by default, or an HTTPS URL
  you set). That host can see IP address, version, platform, and
  architecture. See [Installation](/guide/installation#updates).
- **Marketplace inspect and skill search** contact skills.sh, the npm
  registry, and GitHub when you search skills, inspect, or install. Catalog
  search itself is local. Those parties see the query and the fetch, not
  your journal. See
  [Plugins and skills](/advanced/plugins-and-skills#what-a-marketplace-fetch-discloses).
- **Gravatar** is contacted only if you press the profile button after
  typing an address.
- **Git remotes, GitHub, browser destinations, and remote clients** are
  endpoints you pointed Octant at.

Whether any of those parties is a processor, a sub-processor, or neither
is a legal question this draft does not close. The product fact is that
they are not on the BYO inference path.

## Shared hosts

A later collaboration model would let a team run one host they control.
That design is not the current preview. If it ships, the host owner — not
Ogard Labs — would be the controller of that store. It would not make
BYO providers into Octant sub-processors.

Hosted relay is outside the preview.

## Next steps

- [Privacy notice](/advanced/privacy-notice) for what exists, what leaves, and export or purge
- [Data residency](/advanced/data-residency) for where the store actually sits
- [Providers and models](/advanced/providers) for how instances and credentials work
