# 0061. Agent-to-agent messaging authority

**Status:** Proposed

## Context

`#thread` mentions give a turn a bounded, read-only transcript excerpt.
0049 adds one Chat-only hop: an explicitly mentioned Chat thread may receive
one bounded coordination turn through `octant_thread_message`, depth one, with
Work and Code mentions still read-only. Child AgentRuns already return results
up the 0012 hierarchy; they do not yet have a durable, structured channel to
peer runs or sibling threads.

Users will want agents to hand off findings, ask a sibling run a question, or
nudge a linked thread without inventing a swarm UI or a side channel that
skips sandbox, approvals, or mode clamps. That channel must be designed before
any implementation, because a naive "agents can message each other" tool is a
policy bypass dressed as convenience.

## Decision

- **Structured messages are a server-owned capability**, not a peer socket.
  Senders petition; the host admits, clamps, journals, and delivers. There is
  no direct provider-to-provider pipe and no renderer-minted grant.
- **Endpoints are AgentRuns and real threads** inside one host. Addressing
  uses durable ids the caller already holds. Foreign hosts, unpaired devices,
  and purged or unauthorized threads fail closed.
- **Authority never widens.** Delivery intersects the sender's live effective
  grant with the recipient's mode, Project, thread, and AgentRun ceiling
  (0012). The recipient keeps its own provider, memory, sandbox, and
  approvals. A message cannot start Full access, clear taint, install an
  extension, or approve on anyone's behalf.
- **Bodies are untrusted external content.** On delivery the host frames the
  body as data (0009), appends
  `thread.external-content-ingested@1` with opaque source labels on the
  recipient thread, and never treats instruction-shaped text as executable.
  Raw bodies stay out of journal payloads; events carry opaque references and
  bounds only.
- **0049 stays the Chat mention path.** This record does not replace
  `octant_thread_message`. Mentions remain the user-visible grant for that
  one-hop Chat tool. Broader messaging is a separate app-managed tool family
  admitted under its own policy, with hard bounds on depth, fan-out, payload
  size, and open in-flight messages.
- **Hierarchy, not swarm.** Parent/child and linked-thread edges from 0012
  remain the product. Messaging does not invent teams, rooms, or broadcast
  groups. Cross-mode delivery is allowed only when both endpoints share the
  admitting principal's Open scope and the recipient mode can accept the
  clamped payload shape; Work and Code recipients never inherit Chat-only
  coordination shortcuts that skip their root and approval rules.
- **Journal before side effect.** Planned event names (contracts sketch, not
  shipped): `agent.message-sent@1`, `agent.message-delivered@1`,
  `agent.message-refused@1`, `agent.message-acknowledged@1` on an
  `agent-message` aggregate. Every event requires a durable `messageId`.
  Required payload fields by event:
  - sent: `messageId`, `correlationId`, `senderThreadId`, optional
    `senderRunId`, `recipientThreadId`, optional `recipientRunId`,
    `bodyReference`, `byteLength`, `occurredAt`
  - delivered: `messageId`, `correlationId`, `recipientThreadId`, optional
    `recipientRunId`, `bodyReference`, `byteLength`, `occurredAt`
  - refused: `messageId`, `correlationId`, `refuseReason`
    (`unauthorized`, `depth-exceeded`, `recipient-terminal`, `oversize`,
    `policy`), `occurredAt`
  - acknowledged: `messageId`, `correlationId`, `occurredAt`
    Duplicate or out-of-order provider events apply idempotently.
- **Target matrix vs 0049.** 0049 remains Chat-only for
  `octant_thread_message` and does not admit Work or Code write hops.
  This record adds a separate tool family that may target Chat threads, Work
  threads, Code threads, and AgentRuns when the admitting principal's Open
  scope covers both endpoints. It does not supersede 0049's Chat-only rule
  for the mention tool; Work and Code still refuse that path.
- **Delivery-time authorization.** `agent.message-sent@1` is admission only.
  Before `agent.message-delivered@1`, the server rechecks the sender's live
  grant and the recipient's lifecycle. Grant revocation, recipient closure,
  or purge between the two events refuses delivery (`unauthorized` /
  `recipient-terminal`); admission never creates an irrevocable delivery
  right.
- **Implementation stays out** until this record is Accepted and the threat
  model acceptance below is signed off. Until then the only cross-thread
  write path remains 0049's Chat coordination tool.

### Acceptance sketch (gates implementation)

1. Domain policy proves a sender cannot widen recipient authority or skip
   approvals by messaging.
2. Delivery always taints the recipient thread and frames the body as data.
3. Contract tests decode the four event payloads and refuse oversized or
   path-bearing labels.
4. Replay rebuilds in-flight and refused message projections without
   resurrecting purged bodies.

## Consequences

- Later work adds contracts, domain clamps, a journaled delivery service, and
  honest tool capability reporting before any UI affordance.
- Parent result acknowledgement (0012) stays distinct from messaging;
  returning a child result is not a free-form peer message.
- Operators get an auditable trail of who petitioned whom, and every refuse
  reason stays a value the caller must handle.

## Related

- 0002 Durable event journal and rebuildable projections
- 0003 Product modes and authority
- 0009 Sandbox confinement, approvals, and Plan mode
- 0012 Mixed-provider subagents and agent runs
- 0049 Explicit Chat thread dialogue
- `docs/security/agent-to-agent-messaging-threat-model.md`
