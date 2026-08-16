---
version: 1
slug: "apps-web-src-chat-chatworkspace-tsx"
primary_target: "apps/web/src/chat/ChatWorkspace.tsx"
related_targets:
  [
    "apps/web/src/chat/ChatComposer.tsx",
    "apps/web/src/chat/ChatTranscript.tsx",
    "apps/web/src/chat/ChatWelcome.tsx",
  ]
---

# Chat workspace brief

- Scope and mode: Shared Chat workspace, Operate mode, across authenticated web and Electron renderer.
- Audience and job: Multi-provider AI users starting, reading, and resuming focused conversations while retaining clear provider and mode context.
- Primary task: Read the conversation and send a message with provider/model, tools, attachments, and context available in one coherent composer.
- Content and states: Empty, active, streaming, waiting, error, attachment, extension/context selection, and no-provider states; no invented claims or filesystem authority.
- Constraints: Preserve server authority, provider-neutral commands, virtual Chat Projects, keyboard access, responsive single-pane behavior, and existing theme/accessibility settings.
- Direction: Warm-neutral default in light and dark, with a calm centered conversation column and integrated composer using original Octant components and copy.
- Memorable moment: The composer reads as one quiet instrument panel—draft above, context and model below—while the transcript remains visually dominant.
- Open decisions: None for this implementation slice; native Electron visual acceptance remains separate from browser-first shared-renderer QA.
