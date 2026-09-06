# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Octant first serves solo power users who coordinate many active projects and repositories with AI agents. They need to move between threads quickly, understand what is running or blocked, inspect evidence, and intervene without losing the current work context.

## Product Purpose

Octant is a local-first agent development environment for Chat, Work, and Code across multiple AI providers. It succeeds when one person can supervise concurrent project work, use thread-owned tools beside the conversation, and finish only when a confirmed delivery target has objective evidence.

## Positioning

Octant makes the host authoritative for mode, Project, thread, provider, approval, workspace, and agent-run state. Providers remain replaceable execution engines behind one durable hierarchy, while project data, credentials, journals, and tools stay on machines the user controls.

## Operating Context

Users work across repositories and document projects with long-running threads, child AgentRuns, terminals, browser sessions, files, reviews, pull requests, approvals, plans, and delivery evidence. The primary workspace is the active thread. The sidebar organizes Projects and threads, while the right dock and bottom panel hold live tools owned by that thread.

## Capabilities and Constraints

- Chat, Work, and Code are server-enforced modes with different authority.
- Work and Code Projects bind OS-confined roots; Chat Projects grant no filesystem authority.
- Child AgentRuns inherit or narrow parent authority and use one provider-neutral hierarchy.
- Project and thread state is local-first, journaled, rebuildable, and server-authoritative.
- The interface must remain usable with many Projects and concurrent runs.
- Tool regions must never obscure ownership or starve the active thread.
- Unsupported, stale, denied, unavailable, and failed states must remain explicit.
- No core capability may depend on one provider.

## Brand Commitments

The product name is Octant. The interface should remain an original quiet graphite workbench. Compact structure, information density, dark-surface discipline, restrained borders, and low-noise controls are binding requirements. No external product's assets, terminology, or distinctive structure enters the interface. Octant must avoid too much chrome, low contrast, and sparse screens that hide useful project or orchestration state.

## Evidence on Hand

- Product and architecture contract: `AGENTS.md`, `docs/architecture.md`, and `docs/decisions/`.
- Current visual contract: `DESIGN.md`.
- Approved workspace and dogfood plan: `docs/plans/ade-spine-and-first-run-review.md`.
- Maintainer-supplied reference screenshots for sidebar, terminal, Environment, and overall workspace density.
- No external customer claims, benchmarks, testimonials, or telemetry are available and none should be fabricated.

## Product Principles

1. Keep the active work legible while making many Projects easy to scan.
2. Show authority, ownership, progress, and blocked state without creating a second task system.
3. Keep tools beside the thread and preserve their server-owned lifecycle.
4. Prefer compact, high-information layouts over either dashboard walls or empty canvases.
5. Make every visible action work, explain its refusal, or remain absent.

## Accessibility & Inclusion

The shared renderer targets WCAG AA, complete keyboard operation, visible focus, reduced motion and transparency support, non-color status cues, and stable recovery from loading, error, unavailable, and denied states.
