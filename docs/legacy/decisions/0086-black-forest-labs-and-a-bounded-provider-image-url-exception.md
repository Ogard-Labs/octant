# 0086. Black Forest Labs and a bounded provider-image-URL exception

**Status:** Accepted

## Context

0055 defines two dedicated image provider kinds (`openai-image-http`,
`gemini-native-image-http`); 0085 added a way to ride an
`openai-compatible-http` instance for a vendor whose image API already mirrors
OpenAI's shape. Black Forest Labs (BFL) FLUX is neither: it is image-specific
like the two 0055 kinds, but its API differs from every adapter Octant has
today in two ways at once — the model is encoded in the URL path, not a body
field, and generation is asynchronous. A submit call returns a `polling_url`;
only a completed poll response carries the image, and it carries it as a
signed URL good for about ten minutes, never inline bytes. 0056's decision
that "request and response decoding reject URL forms; only base64/inline
payloads become bytes" was written for providers that return bytes directly.
BFL — and Ideogram, planned immediately after this one — cannot satisfy that
rule at all, since neither ever offers an inline alternative.

## Decision

- **`bfl-image` / `bfl-image-http` is a new dedicated image provider kind**,
  following 0055's pattern exactly: a fixed base URL (`https://api.bfl.ai`), a
  manual model allowlist seeded with BFL's endpoint-path names (`flux-pro-1.1`,
  `flux-pro-1.1-ultra`, `flux-dev`, `flux-kontext-pro`, `flux-kontext-max`,
  `flux-2-pro`, `flux-2-flex`), no user-editable base URL, and no eligibility
  as a Chat, Work, or Code turn driver. This is the "extra vendors" growth
  0056's own Consequences section already anticipated: "Follow-up adapters
  (polling URL results, extra vendors) reuse the job and attachment contracts
  rather than widening the journal." BFL generates exactly one image per
  submit call and accepts no reference images; a request asking for either
  fails closed with `invalid-configuration` rather than emulating them with
  parallel calls or silently dropping the references.
- **A narrow, explicit exception to 0056's "reject URL forms" rule.** An
  adapter MAY perform exactly one additional bounded GET, immediately, to the
  URL its own just-completed authenticated provider call returned. This is not
  a general license to fetch URLs: it never applies to a URL a user supplied,
  one discovered indirectly, or a second or later URL found inside that same
  response. The fetch follows no redirects, is bounded by the same size and
  time limits as any other image fetch, and the URL string itself is discarded
  the instant the bytes are read — never journaled, never stored in an
  attachment record, and never rendered to a person as a link. Only the
  resulting bytes become the artifact, exactly as a base64 response would.
  `fetchApprovedImageUrl` in `apps/server/src/image/imageHttp.ts` is the one
  place this exception is implemented, so the next vendor needing the same
  shape (Ideogram) reuses it rather than opening a second exception.
- **Every other 0056 rule stands unchanged.** Job lifecycle, one profile per
  job, artifact scope, terminal safety refusals, and restart handling all
  apply to BFL exactly as they apply to the OpenAI and Gemini adapters. BFL's
  poll loop stays cooperative with cancellation — an `AbortSignal` observed
  between polls, not only on the next HTTP call — because a job can sit in
  `running` for the length of a generation, and 0056 already requires
  cancellation to reach the adapter fetch promptly.

## Consequences

- BFL FLUX becomes available as a Settings image profile with no change to
  the job, attachment, or journal contracts: a job still carries one profile
  id, artifacts are still `{attachmentId, hash, size, mime}`, and a completed
  job looks identical whether the bytes arrived inline or through the bounded
  exception.
- The bounded-fetch exception is reusable, not bespoke: Ideogram's adapter,
  planned immediately after this one, calls the same `fetchApprovedImageUrl`
  helper instead of receiving its own carve-out.
- `ImageHttpAuth` generalizes from a closed `"bearer" | "goog-api-key"` union
  to a small header descriptor so BFL's raw `x-key` header does not add a
  third hardcoded string and more hardcoded header logic to
  `performImageHttpRequest`; OpenAI Image and Gemini Image keep their existing
  request behavior unchanged under the new shape.
- A vendor whose image API returns bytes directly has no reason to invoke this
  exception — it exists for the polling-URL shape specifically, not as a
  general allowance, and 0056's original rule still governs every adapter that
  can satisfy it.

## Related

- 0005 Provider SDK contract, registry, and honest capabilities
- 0055 Image generation provider profiles
- 0056 Image generation jobs, adapters, and artifact scope
- 0085 Image generation rides an OpenAI-compatible provider too
