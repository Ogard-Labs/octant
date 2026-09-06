# 0085. Image generation rides an OpenAI-compatible provider too

**Status:** Accepted

## Context

Octant generates images through two dedicated provider kinds today:
`openai-image-http` and `gemini-native-image-http` (`docs/decisions/0055`). Both
are fixed-base-URL profiles with a manual model allowlist — the right shape for
a vendor Octant supports by name, but the wrong shape for a person who already
runs an OpenAI-compatible endpoint whose API happens to also serve images.
Recraft is the concrete case: its image API deliberately mirrors OpenAI's
`images/generations` and `images/edits` shape, so it needs no bespoke adapter,
no new provider kind, and no second credential — only a way to say "this
instance's model also generates images."

`docs/decisions/0084` already solved this exact problem for speech: rather than
minting a fixed-URL provider kind for one more capability, transcription and
synthesis each resolve against an enabled `openai-compatible-http` instance
chosen in Settings. Image generation has the same shape of answer, with one
difference — voice has exactly two directions and names one endpoint each;
image generation has no fixed cardinality, since a person may want Recraft for
one model and an Azure OpenAI deployment for another, both alongside their
dedicated OpenAI Image or Gemini Image profiles.

## Decision

- **Image generation may resolve against an enabled `openai-compatible-http`
  instance, the same way voice does.** Settings names an instance and a model
  as a "custom image source." One instance can serve chat, voice, and images
  at once — a person who already added an Azure OpenAI or Recraft endpoint has
  nothing new to configure beyond naming the model for images.
- **This does not touch or contradict 0055's "image kinds carry no
  user-editable base URL" rule.** That rule is scoped to the two dedicated
  image kinds 0055 defines. `openai-compatible-http` is a 0007 kind with its
  own endpoint policy (HTTPS or loopback, `none` authentication only on
  loopback); it was never covered by 0055's rule, exactly as 0084 already
  established for voice. Nothing here adds a base URL field to
  `openai-image-http` or `gemini-native-image-http`.
- **Custom sources are a list, not named slots.** Voice has two fixed
  directions and names one endpoint each. Image generation has no such fixed
  cardinality: Settings › Image Generation holds a bounded list of
  `{providerInstanceId, modelId, label}` entries, any number of which may be
  configured at once alongside the dedicated OpenAI Image and Gemini Image
  profiles.
- **A custom source is validated by exact membership, not by an arbitrary
  model string.** Generation checks the requested `(providerInstanceId,
  modelId)` pair against the configured list at request time. A model ID that
  merely looks plausible is not enough, and removing or disabling the named
  instance never falls back to a different one — the request fails closed with
  a reason, the same posture 0084 established for voice.
- **The adapter reuses the existing OpenAI-compatible wire path.** Requests to
  a custom source ride the instance's own base URL, credential, and endpoint
  policy through `images/generations` and `images/edits`, mirroring the fixed
  OpenAI Image adapter's request and response handling. A response that
  returns an image URL instead of inline bytes is rejected the same way the
  dedicated OpenAI adapter rejects one; fetching a returned URL is out of scope
  for this phase.
- **Every other 0055 and 0056 rule stands unchanged.** Model allowlists,
  generation defaults, job lifecycle, artifact scope, and turn-driver
  ineligibility are unaffected. A custom image source is never offered as a
  Chat, Work, or Code turn driver merely because it can also generate images.

## Consequences

- Recraft, and any other OpenAI-compatible image host, works from Octant with
  zero per-vendor code: adding the endpoint under Providers & Models and
  naming it in Settings › Image Generation is the whole setup.
- Settings › Image Generation is the one place a custom source is added, its
  live status read, and it is removed. The `/api/image/profiles` route and the
  `octant_create_image` agent tool both resolve the same configured list, so
  neither can offer a source Settings does not know about.
- Dedicated adapters for other image-specific vendors (Black Forest Labs,
  Ideogram) remain their own future work; they are not OpenAI-compatible and
  need their own provider kind and adapter, not this path.
- Threading the configured custom-source list into the in-renderer image
  generation surface's picker (`ChatWorkspace`, `WorkspaceView`) is separable
  follow-up work: those call sites read the provider snapshot directly today
  with no settings plumbing in between.

## Related

- 0005 Provider SDK contract, registry, and honest capabilities
- 0007 Direct API providers and the native agent harness
- 0055 Image generation provider profiles
- 0056 Image generation jobs, adapters, and artifact scope
- 0084 Voice rides an OpenAI-compatible provider
