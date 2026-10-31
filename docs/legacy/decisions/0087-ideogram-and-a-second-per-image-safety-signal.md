# 0087. Ideogram and a second, per-image safety signal

**Status:** Accepted

## Context

0055 defines two dedicated image provider kinds; 0086 added a third, Black
Forest Labs (BFL), and the bounded `fetchApprovedImageUrl` exception BFL
needed because it only ever returns a signed image URL, never inline bytes.
0086's own Consequences section named Ideogram as the next vendor planned to
reuse that exception. Ideogram matches BFL there — every generated image
arrives as a URL — but its request is `multipart/form-data` rather than
JSON, generation is synchronous (one response, no polling), and safety
refusal can arrive two ways: the whole request can fail before generation
starts, or the HTTP call can succeed while one or more returned images
individually fails Ideogram's own per-image check.

## Decision

- **`ideogram-image` / `ideogram-image-http` is a new dedicated image
  provider kind**, following 0055's pattern exactly: a fixed base URL
  (`https://api.ideogram.ai`), a manual model allowlist seeded with
  Ideogram's endpoint-path names (`ideogram-v3`, `ideogram-v4`), no
  user-editable base URL, and no eligibility as a Chat, Work, or Code turn
  driver — the same "extra vendors" growth 0056 anticipated and 0086 already
  extended once. Ideogram accepts no reference images in this phase, failing
  closed with `invalid-configuration` on any, matching BFL's own scope cut.
  Unlike BFL, it genuinely generates up to Octant's own variant ceiling in
  one call, so its adapter carries no artificial one-image constraint. The
  request body and synchronous response are mechanical differences from
  every prior adapter, not policy ones; every other 0056 rule — job
  lifecycle, one profile per job, artifact scope, terminal safety refusals,
  prompt cancellation — applies unchanged.
- **A second, per-image safety signal, alongside the whole-request one.** A
  whole-request refusal arrives as HTTP 422 with an error string, the same
  shape as every other adapter's terminal refusal. But a 200 response can
  still carry items with `is_image_safe: false`, Ideogram's own per-image
  check having failed after an otherwise-successful call. Because
  `ImageAdapterResult` is a whole-request union, not a per-image one, **any
  unsafe item turns the entire result into a refusal**: the adapter fetches
  no image bytes once any item fails the check, and never returns a partial
  success with fewer images than requested.
- **`fetchApprovedImageUrl` from `docs/decisions/0086` is reused as-is.**
  Ideogram's adapter calls the same bounded, redirect-free, size/time-capped
  fetch BFL already established, rather than opening a third exception to
  0056's "reject URL forms" rule. Nothing about 0086's exception changes.

## Consequences

- Ideogram becomes available as a Settings image profile with no change to
  the job, attachment, or journal contracts, and no new provider-image-URL
  exception.
- A response mixing safe and unsafe images is deliberately conservative:
  Octant discards the safe images alongside the unsafe ones rather than
  inventing a partial-result shape the rest of the pipeline does not support.

## Related

- 0005 Provider SDK contract, registry, and honest capabilities
- 0055 Image generation provider profiles
- 0056 Image generation jobs, adapters, and artifact scope
- 0085 Image generation rides an OpenAI-compatible provider too
- 0086 Black Forest Labs and a bounded provider-image-URL exception
