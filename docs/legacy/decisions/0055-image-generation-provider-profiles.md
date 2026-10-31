# 0055. Image generation provider profiles

**Status:** Accepted

## Context

0007 makes direct HTTP endpoints first-class provider instances, with
user-supplied base URLs, model allowlists, and write-only Keychain credentials.
Image generation uses the same credential and registry lifecycle, but an image
endpoint is not a Chat, Work, or Code turn driver: selecting one as a thread
model would send conversation turns to an API that cannot chat. A user-editable
base URL on those kinds would also reopen SSRF.

## Decision

- Image profiles are ordinary `ProviderInstance` kinds:
  `openai-image-http` and `gemini-native-image-http`. They reuse the existing
  registry, journaled create/change/remove commands, and Keychain credential
  path (`stored` / `missing` / `unavailable`, purge-on-remove).
- Model allowlists are manual-entry only. Shipped presets (`gpt-image-2` and
  related GPT Image models; Gemini 3.1 image models, with
  `gemini-2.5-flash-image` as a legacy suggestion) are Settings data, never
  rewritten, and never the only accepted IDs. `defaultModel` must be a member
  of the allowlist.
- Image kinds carry no user-editable base URL. Optional generation defaults
  are quality/size for OpenAI and aspect ratio/resolution for Gemini.
- Image kinds are never eligible as Chat, Work, or Code turn drivers. The
  driver factory fails closed; every model picker omits them by kind.
- This record extends 0007's protocol-family list with those two image kinds.
  Remaining 0007 rules stand, including write-only Keychain credentials and
  HTTPS-or-loopback endpoint policy for chat HTTP families.

## Consequences

- Settings can store an image profile and its API key without implying that
  the profile can drive a thread.
- Generation adapters, jobs, artifacts, and invocation stay out of this
  record; they consume the profile kinds defined here.

## Related

- 0005 Provider SDK contract
- 0007 Direct API providers and the native agent harness
