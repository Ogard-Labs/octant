# 0154. Explicit device screenshots reach the provider

**Status:** Accepted

## Context

An agent asking the app-managed Apple or Android tool for a screenshot currently
receives an artifact reference but cannot inspect the screen. Coordinates for
subsequent device input cannot be grounded in that reference alone.

## Decision

- Explicit successful `screenshot` requests may deliver one PNG through the
  existing provider tool image channel, alongside the durable artifact reference.
- This partially supersedes the reference-only screenshot rule in 0014, retained
  by 0043. Its authority, ownership, evidence, approval, and lifecycle rules stand.
- Boot, run, open, input, discovery, and other operations never send screen images
  implicitly. The live pane stream is not provider context.
- Read the returned screenshot reference through the host's existing thread and
  checkout authority resolver and scoped artifact reader. Never accept a path or
  an arbitrary artifact reference from the tool caller.
- Cancellation before or after artifact reading prevents image delivery.
- Keep image bytes separate from the JSON evidence and journal. Existing history
  is not rewritten. Native providers retain their ordinary tool-result history.
- Refuse images larger than the existing provider image wire limit, unavailable
  artifacts, and non-PNG output explicitly. Never truncate images or silently
  resize them: device input coordinates refer to the original screenshot pixels.
- Provider adapters retain their existing image capability checks; an unsupported
  image result cannot be represented as successful visual inspection.

## Consequences

- Supported providers can inspect an explicitly requested device screenshot.
- Large screens may require a later bounded image-and-coordinate contract; the
  current tool reports delivery failure instead of pretending it saw the screen.
- No automatic screenshots enter provider conversations as side effects.
