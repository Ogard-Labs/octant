# Agent-to-agent messaging threat model

**Status:** Draft for design review (not yet maintainer-approved)

**Date:** 2026-08-28

**Threat model id:** `agent-to-agent-messaging-v1`

**Scope:** Structured messages between AgentRuns and real threads on one Octant
host, beyond bounded `#thread` mention excerpts and beyond Chat-only
`octant_thread_message` (0049)

**Design:** [`../decisions/0060-agent-to-agent-messaging.md`](../decisions/0060-agent-to-agent-messaging.md)

## Overview

Cross-thread and cross-run messaging lets one agent petition another with a
bounded, structured body. The host alone admits, clamps, journals, and
delivers. The high-value assets are each thread's mode and Project authority,
AgentRun ceilings, approval state, the append-only journal, and the guarantee
that foreign text cannot become instructions or widen policy.

A design that treats peer agents as mutually trusted peers fails the product:
prompt injection in one run must not mint shell, Full access, or credential
power in another.

## Actors and trust boundaries

### Actors

- **Host user:** the only actor who can widen authority or approve irreversible
  classes.
- **Sending agent:** controls petition text and target ids within its live
  grant. Untrusted with authority.
- **Receiving agent / thread:** processes delivered bodies as data under its
  own policy. Untrusted with the sender's secrets and workspace.
- **Child AgentRun:** equal-or-narrower than its parent (0012). May send or
  receive only inside that clamp.
- **Remote client:** may observe journaled status the principal can Open; cannot
  mint local receipts or exceed host policy.
- **Network and providers:** may delay, reorder, or inject model text; they
  never authorize delivery.

### Trust boundaries

1. Sender petition to server admission (mode, Project, Open, live grant).
2. Server clamp to recipient mode, Project, thread, and AgentRun ceiling.
3. Delivered body to recipient context assembly (data framing + taint).
4. Journal event to projections and remote replay.
5. One host to another host (out of scope; no cross-host messaging).

### Assumptions

- 0009 untrusted-content rules and thread-lifetime taint remain in force.
- 0012 hierarchy, depth, and concurrency ceilings remain in force.
- 0049 Chat coordination stays a separate, mention-gated path. Broader
  messaging (this design) may target Chat, Work, Code, and AgentRuns under
  Open-scope intersection; it does not widen `octant_thread_message` beyond
  Chat.
- Full compromise of the host user is outside containment; messaging must not
  amplify that compromise across Projects or hosts.

## Threats and mitigations

| ID  | Threat                                                              | Mitigation                                                                                                           |
| --- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| T1  | Sender widens recipient authority via message metadata or tool args | Server intersects live sender grant with recipient ceiling; widening refuses `policy` / `unauthorized`               |
| T2  | Message body used as instructions on the recipient                  | Data framing in context assembly; `thread.external-content-ingested@1`; irreversible classes need fresh confirmation |
| T3  | Depth or fan-out loop (A→B→A… or broadcast storms)                  | Hard depth, fan-out, and in-flight caps; refuse `depth-exceeded`; no broadcast groups                                |
| T4  | Messaging skips sandbox, approvals, or Plan-mode read-only          | Ordinary tool-call policy on both sides; message delivery is not an approval or elevation                            |
| T5  | Journal carries secrets or raw bodies                               | Opaque body references and size class only; redaction and payload byte caps                                          |
| T6  | Unauthorized target (foreign Project, purged thread, closed run)    | Open check + lifecycle gate; refuse `unauthorized` / `recipient-terminal` with no title leak beyond opaque ids       |
| T7  | Provider-native side channel bypasses Octant events                 | No peer pipe; only host-delivered messages count; native subagent chat is not this channel                           |
| T8  | Replay or duplicate delivery double-applies side effects            | Idempotent event application; acknowledge is explicit and journaled                                                  |
| T11 | Grant revoked or recipient closed between send and deliver          | Recheck live sender grant and recipient lifecycle before `agent.message-delivered@1`; refuse rather than deliver     |
| T9  | Remote client forges a send                                         | Authenticated principal + host-side admission; remote cannot mint workspace or authority receipts                    |
| T10 | Swarm UI invents team authority above parents                       | Hierarchy remains the product; no rooms, roles, or shared wallets                                                    |

## Event shape sketch (contracts, not shipped)

Aggregate type: `agent-message`. Event names:

- `agent.message-sent@1`
- `agent.message-delivered@1`
- `agent.message-refused@1`
- `agent.message-acknowledged@1`

Payload fields (illustrative): `messageId`, `correlationId`, `senderThreadId`,
optional `senderRunId`, `recipientThreadId`, optional `recipientRunId`,
`bodyReference` (opaque), `byteLength`, `refuseReason`, `occurredAt`. No
absolute paths, raw body text, credentials, or provider payloads.

## Acceptance sketch

| Criterion                        | Evidence when implemented                                                              |
| -------------------------------- | -------------------------------------------------------------------------------------- |
| Authority clamp refuses widening | Domain red/green tests on sender vs recipient ceilings                                 |
| Delivery taints recipient        | Journal + taint projection after one delivered message                                 |
| Bodies framed as data            | Context assembly fixtures; instruction-shaped text not executed                        |
| Events decode and bound          | Contract tests for the four event names and oversize/path labels                       |
| Replay safe                      | Restart test rebuilds in-flight/refused projections without resurrecting purged bodies |
| 0049 path unchanged              | Existing Chat coordination tests remain green                                          |

## Residual risk

- This document is design-only. Controls are not enforced until contracts,
  domain policy, and server delivery land under an Accepted 0059.
- Model-to-model social engineering inside a single already-authorized thread
  remains a residual of ordinary tool use; messaging must not make that worse
  across threads.
- Exact numeric caps (depth, fan-out, bytes, in-flight) are left to the
  implementation ADR acceptance pass so they can track measured abuse, not
  guesswork here.

## Related

- [`../decisions/0060-agent-to-agent-messaging.md`](../decisions/0060-agent-to-agent-messaging.md)
- [`security-architecture-threat-model.md`](security-architecture-threat-model.md)
- [`../decisions/0012-mixed-provider-subagents.md`](../decisions/0012-mixed-provider-subagents.md)
- [`../decisions/0049-thread-dialogue-lane.md`](../decisions/0049-thread-dialogue-lane.md)
- [`../decisions/0009-sandbox-confinement-and-approvals.md`](../decisions/0009-sandbox-confinement-and-approvals.md)
