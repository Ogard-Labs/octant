---
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
