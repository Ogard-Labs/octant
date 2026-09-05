# 0084. Voice rides an OpenAI-compatible provider

**Status:** Accepted

## Context

Octant had no speech capability. Dictating a prompt or hearing an answer read
aloud is ordinary in comparable products, and the one implementation surveyed
piggybacked on a single vendor's private web endpoint through that vendor's
chat login. That shape fails two invariants at once: a core capability may not
require a specific vendor, and an undocumented endpoint reached with a borrowed
session is not a capability the host can report honestly.

The obvious alternative — a new `ProviderInstance` kind for speech, on the
0055 image-profile pattern — would add a fixed-URL vendor profile, a second
credential, and a second Settings object for something every OpenAI-compatible
endpoint already serves beside its chat routes. OpenAI, Groq, Mistral, and
local servers such as whisper.cpp or Speaches all expose `/audio/transcriptions`
and `/audio/speech` under the same base URL and key as `/chat/completions`.

## Decision

- **Speech is an app-managed capability, not a provider kind.** Transcription
  (speech to text) and synthesis (text to speech) each resolve against one
  enabled `openai-compatible-http` instance chosen in Settings › Voice, and run
  on that instance's base URL, authentication, and Keychain credential. The
  0007 endpoint policy therefore bounds voice without a new rule: HTTPS or
  loopback, `none` authentication only on loopback, no redirects.
- **Settings name an endpoint; the registry decides if it can serve.** Voice
  settings live in the journaled shell settings as `voice.transcription`
  (instance + model) and `voice.synthesis` (instance + model + voice). On every
  request the host resolves the reference against the live registry. A removed,
  disabled, or non-compatible instance is `unavailable` with a reason and the
  Settings deep link that fixes it; nothing is ever substituted.
- **Three loopback routes, window-capability gated.** `GET /api/speech/status`
  reports each direction as `ready`, `unconfigured`, or `unavailable`.
  `POST /api/speech/transcriptions` takes multipart audio and returns text.
  `POST /api/speech/synthesis` takes bounded text and returns audio bytes.
  Every response is `no-store`.
- **Bytes are sniffed and bounded, and nothing is persisted.** Audio is
  identified by its signature, never by the declared type; unknown signatures
  are refused. Clips are capped at 10 MB, spoken text at 4,096 characters,
  returned audio at 10 MB, and each direction serves two requests at a time and
  refuses the rest rather than queueing. Audio and transcripts pass through the
  host and never enter the journal or an attachment store.
- **A transcript is text the caller received, not a turn.** The host returns
  it; the caller decides what to do with it. A composer that inserts it still
  needs the person to send.
- **Fails closed, category by category.** An endpoint without audio routes
  answers 404/405/501 and is reported `unsupported`; a rejected key is
  `unauthenticated`; upstream bodies are sanitized to a category and message.
- **System voices are a renderer choice the host never sees.** When no
  synthesis endpoint is configured, a renderer may read text aloud with the
  operating system's own speech synthesizer. That is local, free, and outside
  this record's routes.

## Consequences

- Voice needs no new provider kind, no second credential, and no
  user-editable URL. A person who already has an OpenAI-compatible instance
  configures voice by naming it and a model.
- The Settings › Voice section is the single owner of speech endpoints.
  Navigator, the composers, and any later surface read the same status; none
  keeps its own voice configuration.
- Consumers are follow-ups with their own evidence: a composer microphone that
  inserts a transcript, and Navigator dictation and read-aloud.
- Usage attribution for audio is a follow-up. The usage schema has no audio
  units, and inventing a token equivalence would report a number the provider
  did not give.
- Azure AI Foundry and Anthropic-compatible instances are not offered: their
  audio paths differ or do not exist, and offering them would promise a call
  that fails.

## Related

- 0005 Provider SDK contract, registry, and honest capabilities
- 0007 Direct API providers and the native agent harness
- 0055 Image generation provider profiles
- 0056 Image generation jobs, adapters, and artifact scope
