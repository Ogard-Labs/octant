# Documentation build and VPS handoff

The guide is built for `https://octant.sh/docs/`. The maintainer configures
and publishes it on their VPS. The repository does not deploy it or hold
VPS credentials, and a successful build is not evidence of a live release.

## Build artifact

The Docs workflow checks pull requests, merge-queue commits, and pushes to
`main`; it can also be run manually. It runs the link/anchor, sidebar,
metadata, type and build checks with:

- `OCTANT_DOCS_BASE=/docs/`
- `OCTANT_DOCS_URL=https://octant.sh/docs/`

Each successful run uploads `apps/docs/dist/` as the seven-day artifact
`octant-docs-<commit SHA>`. Use a successful `main` run for publication;
PR and merge-queue artifacts are review builds. The artifact is the static
site, with assets, clean-URL pages, sitemap and custom `404.html`.

A local equivalent is:

```sh
bun install --frozen-lockfile
bun run --filter @octant/docs check:links
bun run --filter @octant/docs check:sidebar
bun run --filter @octant/docs test
bun run --filter @octant/docs typecheck
OCTANT_DOCS_BASE=/docs/ OCTANT_DOCS_URL=https://octant.sh/docs/ bun run --filter @octant/docs build
```

## Maintainer publication

1. Download the artifact for the selected successful `main` commit.
2. Publish its contents to the VPS directory served at `/docs/`. The VPS
   configuration must support clean URLs (for example `/docs/guide/export`
   serves `guide/export.html`) and directory indexes.
3. Serve the supplied `404.html` with HTTP status 404 for missing docs URLs.
   Keep its `/docs/` asset and navigation paths intact.
4. Confirm the home page, a nested guide page, assets and one missing URL;
   check that canonical links and `sitemap.xml` use `https://octant.sh/docs/`.
5. Record the deployed commit and observed results. Any final publication
   review applicable to the content remains a separate gate.

The workflow never uploads to the VPS or claims that those checks passed.
No deployment hostname, private key or server path is needed in this repo.
