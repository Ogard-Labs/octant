// Keep this browser-safe copy in sync with skills/review-in-parallel/SKILL.md.
// The bundled extension catalog is consumed by the shared web renderer, so it
// must not depend on Node's filesystem or crypto modules.
export const REVIEW_IN_PARALLEL_SKILL_CONTENT = `---
name: review-in-parallel
description: Fan out read-only parallel reviewers as independent linked threads.
modes: chat
---

# Review in parallel

Use this skill to spawn independent linked-thread reviewers that each receive the
same bounded task instruction with read-only plan authority. This is a linked-thread
fan-out, not an AgentRun or subagent hierarchy.

When invoked from Chat, Octant previews the requested reviewer count, clamps
authority to plan/read-only defaults, and requires explicit confirmation before
creating peers and starting their review turns.
`;

export const REVIEW_IN_PARALLEL_SKILL_DIGEST =
  "sha256:33923587ed579cf922ef55a833d5e528025dfb6e569923d8bd3b0be7b8c59fc9";
