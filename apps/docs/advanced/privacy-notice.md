---
description: Privacy in self-hosted Octant — no telemetry, local storage, and connections you choose.
---

# Privacy

Ogard Labs distributes Octant as self-hosted software. Ogard Labs does not
collect or process your Octant workspace data and operates no Octant account,
content store, relay, or public-link service. Octant sends no telemetry,
analytics, usage reports, or crash reports to Ogard Labs.

## Your host and your data

Projects, threads, memory, attachments, settings, and logs are stored on the
host you control. Credentials stay in that host's credential store or your
linked password manager. Remote clients connect to your host; Ogard Labs does
not receive a copy of the journal.

You choose where the host and its backups live. The current preview relies
on host storage protection rather than app-level database encryption.
[Privacy and security](/advanced/privacy-and-security#local-storage) explains
the storage, export, retention, and confirmed purge controls, including their
limits. Ogard Labs cannot access or erase a self-hosted installation for you.

## Connections you choose

- **AI providers and integrations:** prompts and selected context go to the
  providers, Git remotes, connectors, and other destinations you configure.
  Their own terms, processing locations, and retention apply.
- **Publishing and exports:** a public link goes to a share service you run
  or choose. A Gist, sharehtml.org page, or Claude artifact goes to that
  selected service. Its operator can read published content. Unlisted links
  are accessible to anyone who has the link. See
  [Export](/guide/export) and [Public links](/guide/public-links).
- **Updates:** manual checks, or automatic checks if you enable them, contact
  the update feed at `octant.sh/updates`, which redirects to GitHub. Those
  hosts receive your IP address and request metadata, including version,
  platform, architecture, and release ring. Automatic checking is off by
  default. See [Updates](/guide/installation#updates).
- **Marketplace:** searches and downloads contact npm, skills.sh, or GitHub
  and disclose the search text, IP address, and request metadata. The
  marketplace-fetches switch also controls provider-version checks. See
  [Marketplace traffic](/advanced/plugins-and-skills#what-a-marketplace-fetch-discloses).
- **Profile picture:** Gravatar receives an email-address hash and request
  metadata only if you request the lookup. The returned picture is stored
  locally. The hash is not a promise of anonymity.

These connections are separate from telemetry. Provider runtimes have their
own privacy behaviour: choosing Claude artifacts explicitly enables Claude
Code's usage telemetry to Anthropic for those turns. See
[Claude artifacts](/advanced/providers#claude-artifacts).

## Operating a host

You choose the data stored and sent by your installation. If you use Octant
for an organisation or publish other people's personal data, determine the
applicable permissions, legal basis, provider agreements, and retention for
that use. This software does not assign legal roles to a machine owner or
certify an operator's GDPR compliance.

For the software licence and company contact, see
[Licence and contact](/advanced/terms). This page describes the self-hosted
software; it does not describe information you separately send to Ogard Labs
in correspondence.
