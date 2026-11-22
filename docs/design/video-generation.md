# Video generation

This topic specification owns short video clips that an agent or a person
generates with a video provider the person set up. It covers:

- the provider seam every video provider plugs into;
- which providers ship with Octant and which are left to plugins;
- what the person sees and confirms before money is spent;
- the limits;
- where a clip is stored and for how long, and who can watch it;
- what happens to a job when the host restarts;
- how a clip is saved as a file.

Image generation, which this design follows wherever it can, stays in
[Architecture: Providers](../architecture.md#providers). The agent tool table
in [Agent tools](agent-tools.md) gains a row only when this is built.

Status: approved, being built (maintainer decision, 2026-11-22). The maintainer
approved the design and asked for two things: video works like image
generation, as provider plugins, and it supports more than one provider. He
approved the three first-party drivers below the same day: the Gemini API's
Gemini Omni Flash, Runway, and fal.

It is built as one stack of three layers:

1. this design, the seam with its conformance harness, and the Gemini driver;
2. the host: the job service, storage, recovery and spend, the agent tool and
   its card, the viewer and the save;
3. the Runway and fal drivers.

## Why

People ask agents for short clips as often as they ask for images: a product
teaser, a looping background, a storyboard shot. The image stack already has
the pieces a video needs:

- provider profiles;
- driver plugins behind a capability-scoped seam;
- a journaled job;
- an offer card in the thread;
- an inline result;
- a confined save.

A video differs in three ways that need decisions before code:

- **Cost.** It costs one to two orders of magnitude more than an image, so cost
  and limits come first.
- **Time.** It takes minutes, not seconds, so a restart in the middle has to be
  handled.
- **Size.** A clip is tens of megabytes, so storage, export and paired viewing
  need bounds.

Providers also differ far more than image providers do. They differ in:

- clip lengths, resolutions and aspect ratios;
- whether audio is generated;
- how a job is cancelled or deleted;
- how long the provider keeps the result;
- how the price is stated.

So the seam has each driver declare these rather than the host assuming one
provider's shape.

## Providers

Every fact below was checked on 2026-11-22 against the provider's own
documentation, read in full unless the entry says otherwise. Where a
provider's own pages disagree, the entry says so and the driver reads the
live price from the provider at build time. Third-party pricing pages are
not used.

### Survey

| Provider                      | Status today                                                                                                             | Access                                          | Clips                                                                              | Job control                                                                                                                      | Price basis                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Google Gemini API             | Gemini Omni Flash `gemini-omni-1.2-flash`, stable since 2026-11-05; `gemini-omni-1.1-flash` routes to it from 2026-12-03 | Self-serve API key; paid tier only              | 3–15 s; 360p, 720p, 1080p, 4K; 16:9, 9:16; 24 fps; native audio                    | Background interaction: poll, cancel, delete; kept 55 days on the paid tier unless deleted                                       | Per output token: $12/M, about $0.07/s at 720p and $0.104/s at 1080p               |
| Google Vertex AI Veo          | `veo-3.1-generate-001` and its fast and lite variants, GA                                                                | Cloud project with IAM or a cloud API key       | 4, 6 or 8 s; 720p, 1080p, 4K; 16:9, 9:16; audio                                    | Long-running operation; output written to the caller's Cloud Storage                                                             | Per second; read from search excerpts only                                         |
| Runway API                    | `gen4.5`, `gen4_turbo`, and resold Veo, Gemini Omni, Kling, Seedance, Wan, Grok and Hailuo models                        | Self-serve API key, credits at $0.01            | `gen4.5`: 2–10 s; 1280:720 or 720:1280 (more ratios from an image); no audio field | Poll a task; `DELETE /v1/tasks/{id}` cancels a running task or deletes a finished one; output URLs expire in 24–48 h             | Credits per second: `gen4.5` 12 credits/s ($0.12/s)                                |
| fal                           | Hosts Veo 3 and 3.1, Kling, Hailuo, Seedance, Wan 3.0, Grok Imagine, Luma Ray-2, LTX and others                          | Self-serve API key                              | Per hosted model                                                                   | Queue: submit, status, result, cancel, webhook; delete removes stored payloads and output files                                  | Per output (second or clip) per model, from a pricing API                          |
| Replicate                     | Hosts Gemini Omni 1.2, Veo 3.1, Kling 4.0, MiniMax H3, Seedance 2.0, Wan 3, Grok Imagine, Runway Gen-4.5, Luma Ray 3.2   | Self-serve API token                            | Per hosted model                                                                   | Prediction: poll, webhook, cancel; inputs, outputs and files are removed after 1 hour by default                                 | Per model: by output or by hardware time                                           |
| MiniMax                       | MiniMax-H3, H3-Highspeed, H3-Lite, H3-Max                                                                                | Self-serve API key                              | 4–15 s (Max 5–15 s); 480P to 2K by variant; seven ratios; audio by default         | Poll or callback; delete cancels a queued task at no charge or deletes a finished one, but not a running one; 7-day query window | Per second: H3 $0.08/s at 768P, $0.13/s at 2K                                      |
| xAI                           | `grok-imagine-video-1.5`, `-1.5-lite`, `grok-imagine-video`                                                              | Self-serve API key                              | 1–15 s; 480p to 1080p; nine ratios; audio by default                               | Poll; no documented cancel or delete for a job; output files deleted through the Files API                                       | Per second: 1.5 $0.08/s, lite $0.02/s                                              |
| Kling                         | Kling 3.0 and Omni; 4.0 listed by resellers                                                                              | Self-serve AccessKey and SecretKey (signed JWT) | 3–15 s; 1080p, 4K; 16:9, 9:16, 1:1; native audio                                   | Not readable: the API reference needs a script host the network blocks                                                           | Per second: v3 std $0.084/s, $0.126/s with audio                                   |
| ByteDance Seedance (BytePlus) | `dreamina-seedance-2-5` and 2.0, GA                                                                                      | Self-serve ModelArk API key                     | 2–30 s; 480p to 4K; seven ratios; audio                                            | Create, then query by id for 7 days; output URL kept 24 h                                                                        | Per video or token; the provider's pages disagree; read from search excerpts only  |
| Alibaba Wan (Model Studio)    | `wan3.0-video`, `wan3.0-video-prime`, Wan 2.7                                                                            | Self-serve API key                              | 2–30 s; 480P to 1080P; seven ratios; audio                                         | Create, then poll by id for 24 h; output URL kept 24 h                                                                           | Per second: Wan 3.0 $0.10/s at 720P; read from search excerpts only                |
| Luma                          | Agents API with `ray-3.2`; Dream Machine API and Ray2 deprecated                                                         | Credits; self-serve keys unconfirmed            | 5 or 10 s; 360p to 1080p                                                           | Poll; no cancel endpoint                                                                                                         | Credits per 5-second block; USD rate not published; read from search excerpts only |
| Pika                          | Pika API with Pika 2.5 and hosted third-party models                                                                     | Self-serve API key                              | Not confirmed                                                                      | Poll                                                                                                                             | Per second: Pika 2.5 $0.04/s at 720p; read from search excerpts only               |
| OpenAI                        | **Shut down.** Videos API and every Sora 2 model shut down 2026-09-24, with no replacement                               | n/a                                             | n/a                                                                                | n/a                                                                                                                              | n/a                                                                                |
| Stability AI                  | **Shut down.** The Stable Video Diffusion API was deprecated 2025-07-24                                                  | n/a                                             | n/a                                                                                | n/a                                                                                                                              | n/a                                                                                |
| Amazon Bedrock                | Nova Reel **shut down** 2026-09-30; Luma Ray2 active                                                                     | AWS IAM signing only                            | Ray2 parameters not confirmed                                                      | Async invoke; output written to the caller's S3 bucket                                                                           | Not confirmed                                                                      |

Sources:

- **Google Gemini API:** [Omni guide](https://aistudio.google.com/docs/omni),
  [model card](https://aistudio.google.com/docs/models/gemini-omni-flash),
  [pricing](https://aistudio.google.com/docs/pricing),
  [background execution](https://aistudio.google.com/docs/background-execution),
  [deprecations](https://aistudio.google.com/docs/deprecations). Every
  `ai.google.dev` page redirects to `aistudio.google.com`. The Veo 3.1
  previews in the Gemini API shut down on 2026-10-22, and no Veo model is
  offered there now.
- **Vertex AI Veo:** [Veo 3.1 model page](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/veo/3-1-generate).
- **Runway:** [API reference](https://docs.dev.runwayml.com/api.md),
  [pricing](https://docs.dev.runwayml.com/guides/pricing.md),
  [outputs](https://docs.dev.runwayml.com/assets/outputs.md).
- **fal:** [queue API](https://fal.ai/docs/api-reference/inference-api/index.md),
  [cancel](https://fal.ai/docs/api-reference/inference-api/queue/cancel.md),
  [webhooks](https://fal.ai/docs/documentation/model-apis/inference/webhooks.md),
  [media expiration](https://fal.ai/docs/documentation/model-apis/media-expiration.md),
  [payload deletion](https://fal.ai/docs/platform-apis/v1/models/requests/payloads.md).
  fal stores request payloads for 90 days by default unless a request sends
  `X-Fal-Store-IO: 0`.
- **Replicate:** [HTTP API](https://replicate.com/docs/reference/http),
  [data retention](https://replicate.com/docs/topics/predictions/data-retention),
  [text-to-video models](https://replicate.com/collections/text-to-video).
- **MiniMax:** [video guide](https://platform.minimax.io/docs/guides/video-generation.md),
  [create](https://platform.minimax.io/docs/api-reference/video-generation-v2-create.md),
  [delete](https://platform.minimax.io/docs/api-reference/video-generation-v2-delete.md),
  [pricing](https://platform.minimax.io/docs/pricing/overview.md).
- **xAI:** [video generation](https://docs.x.ai/developers/model-capabilities/video/generation.md),
  [REST reference](https://docs.x.ai/developers/rest-api-reference/inference/videos.md),
  [model page](https://docs.x.ai/developers/models/grok-imagine-video-1.5.md).
- **Kling:** [llms.txt](https://kling.ai/llms.txt) only. The API reference is a
  script app that could not be read, so cancel, delete, callbacks and
  retention are unconfirmed.
- **ByteDance Seedance:** [product page](https://www.byteplus.com/en/product/seedance),
  [create task](https://ai.byteplus.com/ark/region:ap-southeast-1/docs/create-video-generation-task-api).
- **Alibaba Wan:** [Wan 3.0 guide](https://www.alibabacloud.com/help/en/model-studio/wan3-video-generation-guide),
  [pricing](https://www.alibabacloud.com/help/en/model-studio/model-pricing).
- **Luma:** [Agents API](https://docs.agents.lumalabs.ai/).
- **Pika:** [Pika API](https://dev.pika.art/).
- **OpenAI:** [deprecations](https://developers.openai.com/api/docs/deprecations).
- **Stability AI:** [release notes](https://platform.stability.ai/docs/release-notes).
- **Amazon Bedrock:** [model lifecycle](https://docs.aws.amazon.com/bedrock/latest/userguide/model-lifecycle-legacy.html).

### First-party drivers

Octant ships three video drivers in-tree (maintainer decision, 2026-11-22).
Each imports only the seam, as a third-party plugin would, and passes the same
activation ladder.

1. **Google Gemini API (Gemini Omni Flash).**
   - It reuses the Gemini API key a person already set up for Gemini images.
   - Its published price is low: about $0.07/s at 720p.
   - Its range is wide: 3–15 s, up to 4K, with audio.
   - It is the only provider that reports usage Octant can settle from (tokens).
   - It can both cancel a running job and delete its stored copy.
2. **Runway.**
   - It is a dedicated video provider with self-serve keys and a published
     price.
   - One call cancels a running task or deletes a finished one.
   - It resells several other providers' models under the same key.
3. **fal.**
   - One key reaches most other video models the survey lists: Veo, Kling,
     Hailuo, Seedance, Wan, Grok Imagine and Luma.
   - Its pricing API gives each endpoint's unit price, so the card can show a
     real price.
   - Its queue cancels, and its delete removes stored payloads and output
     files.
   - The driver sends `X-Fal-Store-IO: 0`, so fal keeps no 90-day copy of the
     request.

Between them, these three reach every live model family in the survey except
Pika's own models. Runway also resells MiniMax H3, which fal does not host.

### Left to plugins

- **Replicate.** The second aggregator. Its one-hour default retention is
  attractive, but it has no delete endpoint. Its prices are per model and
  partly by hardware time, so an estimate before the call is weaker.
- **MiniMax, xAI and Kling.** Each is reachable through fal or Runway
  already. A direct driver is worth adding as a plugin for direct billing or a
  model the aggregators lag on.
- **ByteDance Seedance, Alibaba Wan, Luma and Pika.** The same reasons apply,
  and some of their facts could only be read from search excerpts.
- **Vertex AI Veo.** It needs cloud IAM signing rather than an API key. It is
  added under [Enterprise provider identity](enterprise-provider-identity.md)
  when that identity can sign for media drivers.
- **No driver for OpenAI, Stability or Bedrock Nova Reel.** Their video APIs
  are shut down. No OpenAI-compatible custom video source is designed either,
  since no compatible video API exists to be compatible with.

A third-party video driver builds against the same seam as the in-tree
drivers. Loading one from an outside package needs the outside driver format
to carry media drivers. Today it carries only harness-endpoint chat drivers,
and the same is true for image drivers. Loading outside media drivers (image
and video) was approved on 2026-11-22 as its own change and is built
separately. This seam stays compatible with it: a driver is a plain value of
the seam's types, with no host import, so the same value can come from an
outside package.

## Native first

The maintainer asked (2026-11-22) that Octant prefer the native or platform
solution, stay aligned with comparable agent workspaces, and not lock or
restrict features. Comparable workspaces whose public source was read on
2026-11-22 do not generate video themselves and have no video provider, card
or setting. They show what the provider runtime makes natively. Codex's app
server reports its own `imageGeneration` thread items, and those workspaces
render each one as an image in the chat, with no gate, cap or price check of
their own around it. The Codex app-server schema has no video item, so no
runtime they drive generates video natively today.

This design follows that. A runtime's own native media output is shown in the
thread as any provider output is, with no Octant gate. Octant's own video tool
exists for the providers that cannot make video themselves. It reuses the
paid-call rule images already follow rather than inventing a stricter one.

## Rules

Everything in this section is provider-neutral. A driver only declares facts
(see [Seam](#seam)). The host builds the card, the price, the limits, the
spend, the storage, the recovery and the viewing from those facts, the same
way for every provider.

### The card

A generation asks on a card in the thread, exactly as an image generation does
under [Image generation and voice](decisions.md#image-generation-and-voice).
The card shows:

- the prompt;
- any reference images, named, as for images;
- the profile, provider and model;
- the duration, resolution, aspect ratio and audio choice. The person can
  change each within what that model declares.
- the price before Generate, worked out from the model's declared price basis
  and named by who states it, for example "About $0.70 for 10 s at 720p, billed
  by Google". A model that declares no price says "Billed by <provider>; price
  not published", and an active money ceiling refuses it as unknown spend, as
  for images.
- what Stop does, when the model declares it cannot cancel a running job, for
  example "Stop ends the wait; xAI may still finish and bill the clip".

"Don't ask again" is offered as for images and kept the same way: journaled
per Project, or for a Chat thread outside a Project in host memory.

At Full access the card is skipped as it is for images: where the Project
holds that choice or exactly one video profile is ready, and with several
ready, on the profile Settings names for Full access, else the first ready one.
As for images:

- Full access asks again after the person chooses Ask again.
- A kept choice the host can no longer run (its profile turned off, its driver
  plugin disabled or its model removed) is dropped and the person is asked. It
  is never swapped for another model.

A routine or goal loop may generate video where its Project keeps a choice,
since nobody is there to answer a card. Reference images always need the card,
as for images. Plan refuses, because Plan changes nothing outside the host. A
Side Chat never gets the tool.

### Limits

Octant offers what each model declares. It adds only the bounds a host needs
to stay healthy:

| Bound                    | Value                                                                                         | Why                                                                                                                                                                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Clip length              | The model's declared range; default its declared default, else the allowed length nearest 8 s | The provider's own range; a short default keeps a first clip quick and cheap                                                                                                                                                         |
| Resolution, ratio, audio | The model's declared values; default its declared default                                     | The provider's own range                                                                                                                                                                                                             |
| Stored size of one clip  | 1 GB                                                                                          | Far above a 30-second 4K MP4; a larger response is refused, not truncated, so a broken one cannot fill the disk                                                                                                                      |
| Job time                 | 30 minutes                                                                                    | Long enough for a 4K clip under load; the job then fails as `timeout`, and the driver is asked to cancel and forget it                                                                                                               |
| Running jobs             | Two video jobs at a time per host, in slots of their own beside the image queue               | A clip runs for minutes, so sharing the image slots would hold image generations back behind it; restart recovery resumes jobs through the same two slots                                                                            |
| Queued jobs              | 16 video jobs per host, counting only video jobs waiting to start                             | A kept choice lets calls start without a card, so a runaway loop cannot queue without end; image jobs waiting in their own queue do not count against it, and a further video call is refused with "Too many video jobs are queued." |
| Agent call wait          | 2 minutes                                                                                     | As for images; after that the call answers `generating` and the clip appears when done                                                                                                                                               |

### Spend ceilings

A video job counts against the thread's and the Project's spend ceilings,
which the person sets, like any turn.

- **Reserve.** Before Generate is honoured, the host reserves the card's
  estimate against every ceiling that applies. The estimate is the model's
  declared output price for the chosen duration, resolution and audio, plus its
  declared input price for the prompt and reference images where it has one. A
  token-priced model also reserves its declared output-token allowance, so
  billed usage beyond the clip's video tokens — Gemini's thinking tokens —
  still fits the reservation. So a clip that fits a ceiling when approved
  still fits it when settled.
- **Refuse.** If a ceiling cannot cover it, the job is refused with that
  ceiling named, and nothing is sent.
- **Settle.** When the job ends, the reservation settles to the cost the
  driver computes from the usage the provider reports (Gemini's token count),
  or to the estimate when the provider reports none.
  - A job that fails before any output is billed nothing and releases its
    reservation.
  - A cancelled job settles at the reported usage, or at the estimate when
    none is reported, because a provider may bill a job it had already
    started.
- No video-only ceiling is added: the person's own ceilings already cover it.

### Storage, export and deletion

- A clip is stored in a sibling of the generated-image store, under the host's
  data directory. It is written once, named by its hash, bounded to 1 GB, and
  checked as an MP4 from its bytes (`ftyp` box) before it is kept.
- The journal holds:
  - the job's events (`video.job-queued@1`, `video.job-status-changed@1`);
  - a prompt hash;
  - the driver kind;
  - the profile and the provider's opaque job id, kept from the start until
    the provider confirms its copy is removed (or, for a model that cannot
    remove it, until the job ends), so a `forget` retried after a restart
    reaches the right profile's key. That cleanup record (profile, driver
    kind and job id, no prompt or bytes) is kept by the host apart from the
    thread, so deleting the thread before the provider confirms removal
    leaves the retry in place.
  - the artifact reference (hash, size, duration, resolution).

  It never holds video bytes, prompt text or a provider download URL, as for
  images.

- Clips are deleted with their thread. They are included in a thread export
  as files, with the export's size shown before it starts, because a person
  exporting a thread expects its results in it.
- Saving a clip as a file uses the same confined, create-only write as an
  image save, at the turn's level. Plan refuses; Ask first and Auto show a card
  naming the path; Accept edits and Full access write at once.
- The host keeps no copy at the provider where the driver can remove one. As
  soon as the clip is stored, or the job fails or is cancelled, the host calls
  the driver's `forget`, and again during restart recovery. A model that
  declares it cannot remove its copy says on the card how long the provider
  keeps it.

### Watching a clip

- The thread shows a clip after the turn that made it, as a `<video>` element
  with controls, `preload="metadata"` and no autoplay.
- The clip is served by a host route that answers byte-range requests, so
  seeking does not download the whole clip. The route checks the window's or
  device's authority over the thread on every request, as image routes do.
- A paired browser or phone can watch and download clips from threads it can
  open, and answer its own video cards in the thread, as it answers image
  cards. A client that cannot show the card's price cannot approve it.
- A clip can be placed in a Canvas design as a `generated-video` asset in a
  later change. This design does not add the asset kind.

### Interruption recovery

At startup the host reconciles every video job the journal left unfinished:

- A job that was **queued**, so nothing was sent, is marked failed as
  `interrupted` and billed nothing.
- A job that was **running** with a recorded provider job id is resumed while
  the model's declared resume window and the 30-minute job time both allow it.
  - The host polls until the job ends, stores the clip and calls `forget`.
  - The provider may already have billed it, so it is not thrown away.
  - Past either limit, it is cancelled where the driver can cancel, then
    forgotten, and settles at the estimate.
- A job that was **running** with no recorded job id is marked failed as
  `interrupted`. This happens when the host stopped between sending and
  recording the reply. Its reservation settles at the estimate, because Octant
  cannot know whether the provider started it, and the thread says so.
- A waiting card does not survive a restart, as for images. The agent's call
  ends as cancelled, and Needs you shows the notice it shows for images.

### Privacy

- The card names the provider that receives the prompt and any reference
  images. It also says how long that provider keeps them: until Octant removes
  them, or for the period the model declares when its driver cannot remove
  them.
- Reference images follow the image rule. They are named on the card and need
  that card's confirmation, and a model that cannot take them is not offered.
- A clip's result marks the thread as having read outside content, because the
  provider's output enters the thread, as image results do.
- Nothing goes to an Octant-operated service. No telemetry is added.

## Seam

Video drivers live behind a `videoGeneration` seam in `@octant/provider-sdk`
(`@octant/provider-sdk/video-generation`), beside the image seam. In-tree
drivers import only `@octant/contracts` and the seam, and a test fails on any
other import, as it does for images. Bundled video drivers share the
provider-driver component kind and the plugin-host activation ladder, and stay
out of the chat-driver catalog: they cannot start a turn. A profile whose video
driver plugin is disabled fails its jobs as unsupported before any provider
call.

The pure rules every driver and the host run (the default options, the check
of a request against a model's declaration, the estimate and the settlement)
live in the seam package itself (`@octant/provider-sdk/video-generation-policy`,
re-exported from the seam). The seam depends only on `@octant/contracts`, so a
third-party driver needs no other Octant package, and the host imports the same
rules from the seam rather than keeping a second copy.

### What a driver declares

A driver declares, per model it offers:

```ts
export interface VideoModelCapabilities {
  readonly modelId: ProviderModelId;
  readonly displayName: string;
  /** Whole seconds the model accepts; a range, or the exact values for models that take only some. */
  readonly durations:
    | { readonly kind: "range"; readonly min: number; readonly max: number }
    | { readonly kind: "values"; readonly values: ReadonlyArray<number> };
  readonly defaultDuration?: number;
  /** Provider labels, lowest first, e.g. "720p", "1080p", "4k"; "lowest" means the first. */
  readonly resolutions: ReadonlyArray<string>;
  readonly defaultResolution?: string;
  /**
   * e.g. "16:9", "9:16", "1:1". `needsImage` marks a ratio the model takes
   * only from a first frame (Runway's wider ratios), so the card offers it
   * only once an image is chosen.
   */
  readonly aspectRatios: ReadonlyArray<{ readonly ratio: string; readonly needsImage?: boolean }>;
  readonly audio: "none" | "always" | "optional";
  /** For `optional` audio, whether it is on by default; off when absent. */
  readonly defaultAudio?: boolean;
  readonly inputs: {
    readonly firstFrame: boolean;
    readonly lastFrame: boolean;
    /** 0 when the model takes no reference images. */
    readonly maxReferenceImages: number;
  };
  readonly price: VideoPrice;
  readonly job: {
    /** Whether a running job can be stopped at the provider, or only a queued one, or neither. */
    readonly cancel: "running" | "queued" | "none";
    /** Whether the provider's stored copy can be removed, or else how long the provider keeps it. */
    readonly removal:
      { readonly kind: "delete" } | { readonly kind: "expires"; readonly afterHours: number };
    /** How long after starting a job its id can still be polled, for restart recovery. */
    readonly resumeWindowHours: number;
  };
}

export type VideoPrice =
  | {
      /** A published rate per output second, by resolution and audio. */
      readonly kind: "per-second";
      readonly rates: ReadonlyArray<{
        readonly resolution: string;
        readonly audio?: boolean;
        readonly usdMicrosPerSecond: number;
      }>;
      readonly inputUsdMicrosPerImage?: number;
    }
  | {
      /** Billed by token; the driver states tokens per second and the rate, and settles from reported usage. */
      readonly kind: "per-token";
      readonly outputTokensPerSecond: ReadonlyArray<{
        readonly resolution: string;
        readonly tokens: number;
      }>;
      readonly outputUsdMicrosPerMillionTokens: number;
      readonly inputUsdMicrosPerMillionTokens?: number;
    }
  | {
      /** A flat price per clip, by duration and resolution, as many aggregator endpoints publish. */
      readonly kind: "per-clip";
      readonly rates: ReadonlyArray<{
        readonly durationSeconds: number;
        readonly resolution: string;
        readonly audio?: boolean;
        readonly usdMicros: number;
      }>;
    }
  | { readonly kind: "unpublished" };
```

Gemini Omni Flash, for example, declares 3–15 s; 360p, 720p, 1080p and 4K;
16:9 and 9:16; audio `always`; up to six reference images; a per-token price;
and `cancel: "running"`, `removal: delete`, with a resume window of 55 days.
xAI would declare `cancel: "none"`, which puts the Stop line on the card.
A model priced `per-clip` is offered only at the combinations of duration,
resolution and audio it has a rate for, so the card never multiplies a flat
fee by seconds. A rate that omits `audio` applies to both audio choices, and
a rate that names the chosen audio wins over it. The default is a whole
combination that has a rate, never each field chosen on its own. Candidates are
ranked by these rules, in order:

1. the declared default resolution, else the lowest;
2. the declared default audio, else audio off;
3. the length nearest the declared default (or 8 s), with a tie going to the
   shorter.

The card and
a call that skips the card use the same lookup. A call whose combination has
no rate is refused before anything is reserved or sent.

Bundled drivers state prices from the provider's own published pages, checked
when the driver is built or updated. An aggregator driver (fal) reads each
endpoint's unit price from the provider's pricing API when the profile
refreshes its models, and declares `unpublished` for any endpoint whose price
it cannot read. The card names the provider as the one billing, and the
estimate as Octant's.

### What a driver does

```ts
export interface VideoAdapterRequest {
  readonly modelId: ProviderModelId;
  readonly prompt: string;
  readonly durationSeconds: number;
  readonly resolution: string;
  readonly aspectRatio: string;
  readonly audio: boolean;
  readonly firstFrame?: ImageAdapterReference;
  readonly lastFrame?: ImageAdapterReference;
  readonly references: ReadonlyArray<ImageAdapterReference>;
  readonly signal: AbortSignal;
}

export interface VideoAdapterUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly billedSeconds?: number;
}

export type VideoAdapterStart =
  | { readonly status: "started"; readonly remoteId: string }
  | { readonly status: "refused"; readonly safetyRefusal: string }
  | { readonly status: "failed"; readonly providerFailure: ProviderFailure };

export type VideoAdapterPoll =
  | { readonly status: "running" }
  | {
      readonly status: "completed";
      readonly video: { readonly bytes: Uint8Array; readonly mediaType: "video/mp4" };
      readonly usage?: VideoAdapterUsage;
    }
  | { readonly status: "refused"; readonly safetyRefusal: string }
  | { readonly status: "failed"; readonly providerFailure: ProviderFailure }
  | { readonly status: "cancelled"; readonly usage?: VideoAdapterUsage };

/**
 * One video profile's generator. No method rejects: every refusal and
 * failure is a result the job records, so a broken adapter cannot leave a job
 * running.
 */
export interface VideoGenerationAdapter {
  readonly models: () => Promise<ReadonlyArray<VideoModelCapabilities>>;
  readonly start: (request: VideoAdapterRequest) => Promise<VideoAdapterStart>;
  readonly poll: (remoteId: string, signal: AbortSignal) => Promise<VideoAdapterPoll>;
  /**
   * Asks the provider to stop, then reports the job's state with any usage it
   * states. Called only when the model declares it can cancel. A result still
   * `running` means the stop is not yet confirmed: the job service keeps
   * polling until a terminal state or the job time runs out.
   */
  readonly cancel: (remoteId: string) => Promise<VideoAdapterPoll>;
  /**
   * Removes the provider's stored copy, called after every terminal state when
   * the model declares `removal: delete`. A failed `forget` is journaled and
   * retried every 15 minutes while the host runs and at every startup, until
   * the provider confirms the copy is gone.
   */
  readonly forget: (remoteId: string) => Promise<{ readonly status: "removed" | "failed" }>;
}

export interface VideoGenerationDriver {
  readonly driverKind: ProviderDriverKind;
  /**
   * The hosts the provider's own API answers on, fixed in the driver. The host
   * sends the profile's credential only to these over HTTPS.
   */
  readonly providerHosts: ReadonlyArray<string>;
  readonly create: (context: VideoGenerationDriverContext) => VideoGenerationAdapter;
}
```

A driver receives capability-scoped ports, as an image driver does, and never
host internals:

- **`request`.** One authenticated call to the provider. The host:
  - refuses a URL outside the declared hosts before it reads any credential;
  - leases a key from the profile's key pool and sets it in the header the
    driver names;
  - enforces request and response size and time limits;
  - refuses redirects.
- **`fetchApprovedVideoUrl`.** One unauthenticated GET of a download URL the
  provider's own just-completed authenticated call returned. Runway, fal,
  xAI, MiniMax and Replicate all deliver clips this way. The host applies the
  1 GB bound and its time bound, follows no redirects, and never logs or
  stores the URL.
- **`sniffMediaType`.** The host's MP4 check.

The job service owns everything provider-neutral:

- the poll loop and its interval (5 seconds, backing off to 30);
- the job time;
- the reservation and its settlement;
- storage;
- the journal;
- restart recovery;
- when `cancel` and `forget` are called.

The driver owns only the wire and its declared facts.

A conformance harness checks every driver against fake transports:

- the request shape for each declared option;
- that a request outside the declared capabilities is refused before sending;
- polling to each terminal state;
- `cancel` and `forget` where declared;
- the size bound;
- MP4 recognition;
- that the credential goes only to declared hosts;
- that a download URL is fetched only through `fetchApprovedVideoUrl`.

### The tool

The agent tool is `octant_create_video`. It is composed as a built-in media
tool plugin over a new optional `videoGeneration` capability on the public
media tool port (`@octant/plugin-api/media-tools`). It has `generate` and
`save` operations, and the same host-owned boundaries as
`octant_create_image`: confinement, bytes, credentials, spend, consent and the
access level stay in the host.

It is offered in Chat, Work and Code only while an enabled profile has a
video model. It is never offered in Plan or a Side Chat, and in an unattended
turn only where the Project keeps a choice. The tool's schema lists only the
options the selected model declares. Its host line tells every provider to
call it for a clip, instead of writing an animation by hand, only when the
person asks for a video.

## Release boundary

Video generation joins the design-first list in the
[Current Release Boundary](../architecture.md#current-release-boundary). It is
in scope since the maintainer approved this design and its provider shortlist
on 2026-11-22, and it adds no Octant-operated service: the person's own provider key calls the
provider directly from the host. Settings, the card and the viewer ship on
macOS, Linux and Windows alike; nothing in this design is platform-specific.

## Decisions

The maintainer approved each of these on 2026-11-22. Each follows comparable
agent workspaces where they have a rule:

1. **Seam.** The
   provider-neutral seam above. Each model declares durations, resolutions,
   aspect ratios, audio, inputs, price basis, cancel, removal and resume
   window. The host builds every shared behaviour from those facts.
2. **First-party providers.** Google Gemini API (Gemini Omni
   Flash), Runway and fal, shipped in-tree as plugin-shaped drivers.
   Replicate, MiniMax, xAI, Kling, Seedance, Wan, Luma, Pika and Vertex Veo are
   left to plugins.
3. **Native first.** a runtime's own native media output is shown
   in the thread with no Octant gate, as the peers do. Octant's tool serves the
   providers without it.
4. **Asking.** the image rule unchanged, including:
   - "Don't ask again";
   - Full access with a kept or default profile;
   - routines with a kept choice.

   The card shows the price, and what Stop does when the model cannot cancel.

5. **Limits.** each model's own declared range, with only
   host-health bounds: 1 GB per clip, a 30-minute job time, the image queue's
   concurrency, and 16 queued video jobs per host.
6. **Spend.** the person's existing thread and Project ceilings,
   reserved from the declared price. Settled from the provider's reported
   usage, else the estimate. No new video ceiling.
7. **Storage and privacy.** clips are exported and deleted with
   their thread. The provider's copy is removed as soon as the clip is kept
   where the driver can; otherwise the card says how long the provider keeps
   it.
8. **Paired devices.** watch, download and answer their own
   cards, as for images.
9. **Restarts.** a running job with a recorded provider id
   resumes within its declared resume window. One without settles at its
   estimate as interrupted.
