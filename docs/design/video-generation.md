# Video generation

This topic specification owns short video clips an agent or a person
generates with a video model the person set up: which provider APIs Octant
speaks, what the person sees and confirms before money is spent, the limits,
where a clip is stored and for how long, who can watch it, what happens to a
job when the host restarts, and how a clip is saved as a file. Image
generation, which this design follows wherever it can, stays in
[Architecture: Providers](../architecture.md#providers); the agent tool table
in [Agent tools](agent-tools.md) gains a row only when this is built.

Status: designed, not built. Nothing here is implemented, and nothing may be
until a maintainer approves this design. Implementation is then three steps,
each one commit series on one branch: contracts and the job service; the
agent tool and its card; the viewer and the save.

## Why

People ask agents for short clips (a product teaser, a looping background, a
storyboard shot) as often as they ask for images. The image stack already has
the pieces a video needs: provider profiles, a journaled job, an offer card in
the thread, an inline result and a confined save. A video differs in three ways
that need decisions before code. It costs one to two orders of magnitude more
than an image, so cost and limits come first. It takes minutes, not seconds, so
a restart in the middle has to be handled. And a clip is tens of megabytes, so
storage, export and paired viewing need bounds.

## Providers

Provider facts were checked on 2026-11-22 against each provider's own
documentation. Third-party pricing pages disagreed with the providers and are
not used.

### Gemini API: Gemini Omni Flash (the one provider at first)

Google's Gemini API offers clip video generation through Gemini Omni Flash,
`gemini-omni-1.2-flash` ([video overview](https://aistudio.google.com/docs/video),
[model card](https://aistudio.google.com/docs/models/gemini-omni-flash)).

- **Request.** `POST https://generativelanguage.googleapis.com/v1beta/interactions`
  with `model`, `input` (a prompt, or content parts with up to six reference
  images) and `response_format: { type: "video", aspect_ratio, resolution,
duration, delivery }`
  ([guide](https://aistudio.google.com/docs/omni)). Octant sends
  `background: true` so the call returns an interaction id at once, and
  `delivery: "uri"` for any clip over 4 MB.
- **Polling.** `GET /v1beta/interactions/{id}` until `status` is `completed`,
  `failed` or `cancelled`. A running interaction can be stopped with
  `POST /v1beta/interactions/{id}/cancel`
  ([background execution](https://aistudio.google.com/docs/background-execution)).
  With URI delivery, the video file is polled at `GET /v1beta/files/{id}` until
  `state` is `ACTIVE`, then downloaded from `files/{id}:download?alt=media`.
  Google notes that the `uri` field is guaranteed only in the creation response
  or stream; a later `GET` of the interaction returns the video inline as base64.
  The driver handles both.
- **Limits.** Any whole second from 3 to 15 (default 10); 360p, 720p (default),
  1080p and 4K (the last two upscaled); 16:9 (default) or 9:16; 24 fps; MP4 with
  native audio. Every clip carries an invisible SynthID watermark. Safety
  filters apply to the prompt and the result and vary by region. In the EEA,
  Switzerland and the UK, editing uploaded videos and uploading images with
  minors are not available.
- **Price.** Paid tier only; there is no free tier for video output. Output is
  billed by token: $12.00 per million video output tokens, at 5,792 tokens per
  second of 720p. Google states the effective prices as about $0.023/s at 360p,
  $0.07/s at 720p, $0.104/s at 1080p and $0.209/s at 4K, so a 10-second 720p
  clip is about $0.70. Input is $1.50 per million tokens
  ([pricing](https://aistudio.google.com/docs/pricing#gemini-omni-1.2-flash)).
  Because the response reports token usage, Octant can settle a job's cost from
  the provider's own count, unlike images.
- **Retention at Google.** Background execution requires `store: true`, and
  Google then keeps the interaction (prompt, references and video) for 55 days
  on the paid tier unless it is deleted. Files are deleted after 48 hours
  ([data retention](https://aistudio.google.com/docs/interactions-overview#data-storage-retention),
  [files](https://aistudio.google.com/docs/files)). Octant deletes the
  interaction (`DELETE /v1beta/interactions/{id}`) as soon as it has the clip,
  or the job fails or is cancelled, and again during restart recovery.
- **Credential.** The Gemini API key the person already set up for a Gemini
  image profile, sent only to `generativelanguage.googleapis.com` as the image
  driver does today. No new credential path.

### OpenAI: not offered

OpenAI shut down the Videos API and every Sora 2 model (`sora-2`,
`sora-2-pro` and their snapshots) on 2026-09-24, announced on 2026-03-24, with
"no one-to-one replacement"
([deprecations](https://developers.openai.com/api/docs/deprecations),
[video guide](https://developers.openai.com/api/docs/guides/video-generation)).
Octant offers no OpenAI video profile. The Veo 3.1 previews in the Gemini API
(`veo-3.1-generate-preview` and its fast and lite variants) were also shut down,
on 2026-10-22 ([deprecations](https://aistudio.google.com/docs/deprecations)),
so no Veo driver is built against the Gemini API either.

### Later, not in this design

Veo 3.1 GA on Google's Gemini Enterprise Agent Platform needs a cloud project
and cloud IAM signing rather than an API key. It can be added later as a second
driver on the same seam, under
[Enterprise provider identity](enterprise-provider-identity.md). An
OpenAI-compatible custom source for video is not designed: no compatible video
API exists to be compatible with.

## Rules

### The card always asks

Every generation asks the person on a card in the thread before anything is
sent. The card shows:

- the prompt;
- any reference images, named, as for images;
- the profile and model;
- the duration, resolution and aspect ratio, which the person can change
  within the limits below;
- the price before Generate: duration × the published per-second rate for that
  resolution, for example "About $0.70 for 10 s at 720p, billed by Google". A
  model whose price Octant does not know says "Billed by Google; price not
  published" and needs the person to tick that they understand.

"Don't ask again" is **not** offered for video, and Full access does not skip
the card. Each clip costs real money, and a loop of agent calls at Full access
could spend dollars a minute. This is a deliberate exception to the paid-call
rule in
[Image generation and voice](decisions.md#image-generation-and-voice), and
it needs maintainer approval. A turn the host runs as itself (a routine or a
goal loop) is never offered the video tool, since nobody could answer the card.
Plan refuses. A Side Chat never gets the tool.

### Limits

| Limit                        | Value                       | Why                                                                                       |
| ---------------------------- | --------------------------- | ----------------------------------------------------------------------------------------- |
| Clip length                  | 3–10 s, default 8 s         | Omni allows 15 s, but 10 s keeps a clip under about $1 at 720p and keeps extension simple |
| Resolution                   | 360p, 720p (default), 1080p | 4K costs three times 720p and is upscaled anyway; not offered at first                    |
| Stored size of one clip      | 200 MB                      | A 10-second 1080p MP4 is well under it; anything larger is refused, not truncated         |
| Job time                     | 10 minutes                  | The job fails as `timeout` and the remote interaction is cancelled and deleted            |
| Running jobs per host        | 1                           | Others queue; video is slow and costly enough that parallel runs help nobody              |
| Waiting video cards per host | 4                           | A fifth call is refused with "Too many video generations are waiting for an answer."      |
| Agent call wait              | 2 minutes                   | As for images; after that the call answers `generating` and the clip appears when done    |

### Spend ceilings

A video job counts against the thread's and the Project's spend ceilings like
any turn. Before the card's Generate is honoured, the host reserves the card's
estimate against every ceiling that applies. If a ceiling cannot cover it, the
job is refused with that ceiling named, and nothing is sent. When the job
ends, the reservation settles to the cost computed from the token count Google
reports. A job that fails before any output is billed nothing and releases its
reservation. A cancelled job settles at what Google reports, or at the
estimate when Google reports nothing, because Google may bill a job it had
already started.

The design adds one host setting: **Video spend per day**, in Settings ›
Voice & images, default $5.00. It is a host-wide ceiling for video jobs only
and resets at local midnight. It is there because video is the one Octant
capability where a few clicks can spend tens of dollars; it needs maintainer
approval.

### Storage, export and deletion

- A clip is stored in a sibling of the generated-image store, under the host's
  data directory. It is written once, named by its hash, bounded to 200 MB and
  checked as an MP4 from its bytes (`ftyp` box) before it is kept.
- The journal holds the job's events (`video.job-queued@1`,
  `video.job-status-changed@1`), a prompt hash, the provider's opaque
  interaction id while the job runs, and the artifact reference (hash, size,
  duration, resolution). It never holds video bytes or prompt text, as for
  images.
- Clips are deleted with their thread. They are included in a thread export
  as files, with the export's size shown before it starts, because a person
  exporting a thread expects its results in it.
- Saving a clip as a file uses the same confined, create-only write as an
  image save, at the turn's level: Plan refuses, Ask first and Auto show a
  card naming the path, and Accept edits and Full access write at once.
- The host keeps no copy at the provider: the remote interaction is deleted as
  soon as the clip is stored (see Providers).

### Watching a clip

- The thread shows a clip after the turn that made it, as a `<video>` element
  with controls, `preload="metadata"` and no autoplay.
- The clip is served by a host route that answers byte-range requests, so
  seeking does not download the whole clip. The route checks the window's or
  device's authority over the thread on every request, as image routes do.
- A paired browser or phone can watch and download clips from threads it can
  open. It cannot start a video job, and it cannot answer a video card. That
  card is answered at a local window on the host, because every clip costs
  money and the card is the only consent.
- A clip can be placed in a Canvas design as a `generated-video` asset in a
  later change; this design does not add the asset kind.

### Interruption recovery

At startup the host reconciles every video job the journal left unfinished:

- A job that was **queued**, so nothing was sent, is marked failed as
  `interrupted` and billed nothing.
- A job that was **running** with a recorded interaction id is resumed. The
  host polls that interaction until it ends or the 10-minute job time measured
  from its start runs out, then stores the clip and deletes the interaction.
  Google may already have billed it, so it is not thrown away.
- A job that was **running** with no recorded interaction id, because the host
  stopped between sending and recording the reply, is marked failed as
  `interrupted`. Its reservation settles at the estimate, because Octant
  cannot know whether Google started it, and the thread says so.
- A waiting card does not survive a restart, as for images. The agent's call
  ends as cancelled, and Needs you shows the notice it shows for images.

### Privacy

- The card says that the prompt and any reference images go to Google, and
  that Google keeps them until Octant deletes the interaction (at most
  55 days on the paid tier if deletion fails).
- Reference images follow the image rule: they are named on the card, need
  that card's confirmation, and a model that cannot take them is not offered.
- A clip's result marks the thread as having read outside content (the
  provider's output enters the thread), as image results do.
- Nothing goes to an Octant-operated service. No telemetry is added.

## Seam

Video drivers live behind a `videoGeneration` seam in `@octant/provider-sdk`,
beside `imageGeneration.ts`. In-tree drivers import only the seam, and a test
enforces this, as it does for images. A conformance harness checks every
driver against fake transports: request shape, polling, cancellation,
deletion, the size bound, MP4 recognition and declared hosts.

```ts
export interface VideoAdapterRequest {
  readonly modelId: ProviderModelId;
  readonly prompt: string;
  readonly durationSeconds: number; // 3..10
  readonly resolution: "360p" | "720p" | "1080p";
  readonly aspectRatio: "16:9" | "9:16";
  readonly references: ReadonlyArray<ImageAdapterReference>; // at most 6
}

export type VideoAdapterStart =
  | { readonly status: "started"; readonly remoteId: string }
  | { readonly status: "refused"; readonly safetyRefusal: string }
  | { readonly status: "failed"; readonly failure: ProviderFailure };

export type VideoAdapterPoll =
  | { readonly status: "running" }
  | {
      readonly status: "completed";
      readonly video: { readonly bytes: Uint8Array; readonly mediaType: "video/mp4" };
      readonly usage?: { readonly outputTokens?: number; readonly inputTokens?: number };
    }
  | { readonly status: "refused"; readonly safetyRefusal: string }
  | { readonly status: "failed"; readonly failure: ProviderFailure }
  | { readonly status: "cancelled" };

export interface VideoGenerationDriver {
  readonly kind: ProviderDriverKind;
  /** Hosts a credential may be sent to; anything else is refused before sending. */
  readonly declaredHosts: ReadonlyArray<string>;
  readonly start: (input: VideoAdapterRequest, signal: AbortSignal) => Promise<VideoAdapterStart>;
  readonly poll: (remoteId: string, signal: AbortSignal) => Promise<VideoAdapterPoll>;
  readonly cancel: (remoteId: string) => Promise<void>;
  /** Removes the provider's stored copy; called after every terminal state. */
  readonly forget: (remoteId: string) => Promise<void>;
}
```

The job service owns the poll loop, its interval (5 seconds, backing off to
30), the job time, the reservation, storage and the journal. The driver owns
only the wire.

The agent tool is `octant_create_video`, composed as a built-in media tool
plugin over a new optional `videoGeneration` capability on the public media
tool port (`@octant/plugin-api/media-tools`). It has `generate` and `save`
operations and the same host-owned boundaries as `octant_create_image`. It is
offered in Chat, Work and Code only while a Gemini profile with a video model
is enabled, never in Plan, a Side Chat or an unattended turn. Its host line
tells every provider to call it for a clip instead of writing an animation by
hand only when the person asks for a video.

## Release boundary

Video generation joins the design-first list in the
[Current Release Boundary](../architecture.md#current-release-boundary). It is
in scope only once this design is approved, and it adds no Octant-operated
service: the person's own Gemini API key calls Google directly from the host.
Settings, the card and the viewer ship on macOS, Linux and Windows alike;
nothing in this design is platform-specific.

## Decisions this design asks for

1. Gemini Omni Flash on the Gemini API is the only provider at first. OpenAI's
   API is shut down, and Veo GA needs enterprise sign-in.
2. Video never offers "Don't ask again", and Full access still asks.
3. Limits: 3–10 s, up to 1080p, 200 MB, 10 minutes, one job per host.
4. A host-wide **Video spend per day** ceiling, default $5.00, on top of
   thread and Project ceilings.
5. Clips are exported with their thread and deleted with it, and the remote
   interaction is deleted as soon as the clip is stored.
6. Paired devices watch and download but cannot answer a video card.
7. A running job resumes after a restart. An unknown one settles at its
   estimate.
