# User guide ownership and VPS handoff

The VitePress guide lives in [Ogard-Labs/octant-site/docs](https://github.com/Ogard-Labs/octant-site/tree/main/docs).
Its source, dependencies, checks, theme projection and static build belong there;
there is no guide workspace or deployment workflow in this monorepo. Internal
architecture and design specifications remain here.

## Keeping application changes and the guide together

For a change that affects setup, security or user-visible behavior, edit the
owning internal specification here and update the relevant guide pages in a
companion PR in `octant-site`. Link both PRs in their descriptions. The PR
checklist requires that link or a reason the guide needs no update. Keep
unmerged behavior paired with its product PR rather than claiming it shipped.
Existing in-flight guide edits must be transferred to that repository before
their product PR lands; do not recreate `apps/docs`.

For semantic theme changes, generate the guide's checked-in data projection:

```sh
bun run docs:theme > /path/to/octant-site/docs/.vitepress/theme/theme-tokens.json
```

Use the executable directly (`bun scripts/export-docs-theme.ts`) if a runner
adds output to stdout. The JSON records an immutable source revision. Commit
it in the companion guide PR and run the site's theme tests and build. The
guide consumes this data without a workspace dependency or network fetch.

## Build and publication

The site repository's Docs workflow checks pull requests, merge-queue commits,
and main pushes, and can be run manually. It tests metadata, anchors, links,
sidebar coverage and types, checks formatting, and builds with:

- `OCTANT_DOCS_BASE=/docs/`
- `OCTANT_DOCS_URL=https://octant.sh/docs/`

Each successful run uploads `docs/dist/` as `octant-docs-<commit SHA>`, retained
seven days. Use a successful site `main` build for publication; PR artifacts
are review builds. The root marketing site remains independent of this build.

Henrik configures and publishes the artifact on the VPS at
`https://octant.sh/docs/`. Serve clean URLs and directory indexes, and the
supplied `404.html` with HTTP status 404 for missing docs URLs. Verify the home
page, a nested page, assets, canonical URLs and sitemap, then record the deployed
site commit. A build is not live publication, and applicable content-review gates
remain separate. Neither repository's guide workflow deploys or needs VPS keys.
