# Agent access from other machines

Status: Approved (2026-11-11, maintainer). AA-11 decided: reach stays on the
person's own network.
Size: Full: a new remote principal, a credential, a listener surface, a
server-hosted MCP endpoint, Settings, and a CLI enrollment step.
Owner: maintainer · Started: 2026-11-11
Build status: all five slices are built: grants, the endpoint, the bridge,
direct keys, and visibility (Settings › Remote access › Agent access, "Started
by" on threads and in Needs you, push labels, and the paired-device view and
revoke), with each turn an agent sent named for it. The built rules are in
[Architecture: Security and authority](../architecture.md#security-and-authority)
and [Decisions and requirements](decisions.md).

An agent running on another machine can start and follow work in Octant: a bot
on a home server, a coding CLI on a second laptop, a script on a build box. It
uses the same tools `octant agent mcp` offers on the host itself
([Architecture: scripted callers and other agents](../architecture.md#native-harness)),
under a grant the person creates, scopes, and can revoke at any time.

## 1. Names

"Bot" already means Octant's own host-resident assistants, and "Project grant"
is a bot's permission ([Bots](bots.md)). This design uses:

| Term          | Meaning                                                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Outside agent | A program on another machine that calls Octant on the person's behalf. It is never the person.                         |
| Agent grant   | What one outside agent may do: which Projects, which modes, the highest access level, which tools, limits, and expiry. |
| Agent key     | The credential that proves a request comes from the agent a grant was issued to.                                       |
| Agent access  | The Settings section and CLI command group that create, show, change, and revoke agent grants.                         |

## 2. Requirements

| ID    | Requirement                                                                                                                                                                                                                                                                                                                                                                      |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-1  | An outside agent on another machine on the person's private network can start a Chat, Work, or Code thread in a Project its grant names, send further prompts, read the result, answer the thread's questions, and stop a turn.                                                                                                                                                  |
| FR-2  | Telling a bot "open an agent in my repo in Octant and fix x" works with one tool call, as it does locally (`start_work` with a Project).                                                                                                                                                                                                                                         |
| FR-3  | The person creates a grant, sees every grant with its last use, and revokes or changes it from a local window or the CLI; a paired device can see and revoke grants but not create or widen them.                                                                                                                                                                                |
| FR-4  | Approvals and other requests a thread raises wait on the person in Octant's Needs you list, named as coming from the agent's thread, and reach the person's phone like any other.                                                                                                                                                                                                |
| SEC-1 | An outside agent never exceeds its grant, and a grant never carries remembered answers, approvals, administration, terminals, or the host Browser. A grant's highest level may be Full access when the person chooses it for that grant (maintainer decision, 2026-11-12). An agent grant is not a paired device: the rule that a paired device is the person does not reach it. |
| SEC-2 | Every mutation is journaled with the outside-agent principal; no agent key or secret enters the journal.                                                                                                                                                                                                                                                                         |
| SEC-3 | Revocation takes effect on the next request and ends open sessions and in-flight requests, as device revocation does.                                                                                                                                                                                                                                                            |
| SEC-4 | Reach stays on the person's own network: LAN-private and Tailscale source classes only. Nothing is operated by Octant (AA-11).                                                                                                                                                                                                                                                   |
| SEC-5 | Prompts from an outside agent are outside content: the thread is marked from its first turn, as a thread that read outside content is.                                                                                                                                                                                                                                           |
| NFR-1 | Spend is bounded per grant: running turns at once, turns per day, and request rate.                                                                                                                                                                                                                                                                                              |
| CON-1 | No Octant-operated relay, account, or service (Principles; [Current Release Boundary](../architecture.md#current-release-boundary)).                                                                                                                                                                                                                                             |
| CON-2 | Remote transport and authority are host concerns, not a plugin seam: like the listener, agent access is host transport.                                                                                                                                                                                                                                                          |

Out of scope: outside agents answering approvals, choosing a level above their
grant's own, adding
or binding Projects, reading credentials, changing settings, administering the
listener, pairing, or other grants; agent-to-agent work between hosts (that is
[Hub and spokes](hub-and-spokes.md)); and any path over the public internet
(AA-11).

## 3. Conceptual design

### Context

```text
 other machine                              the person's host
┌──────────────────────┐   private network   ┌──────────────────────────────────────┐
│ MCP client (a bot,   │                     │ private listener (HTTPS, LAN or      │
│ a coding CLI)        │                     │ Tailscale only)                      │
│   │ stdio            │   bridge: signed    │   └─ agent-access surface            │
│   ▼                  │   requests, pinned  │        /api/agent-access/mcp         │
│ octant agent mcp ────┼──── TLS ───────────►│          │ outside-agent principal   │
│   --connection file  │                     │          ▼                           │
│                      │   direct: bearer    │   server-hosted agent MCP handler    │
│ MCP client speaking ─┼──── agent key over ►│     grant check → thread commands    │
│ Streamable HTTP      │   Tailscale cert    │     under the principal → journal    │
└──────────────────────┘                     │   Needs you ◄─ approvals, questions  │
                                             └──────────────────────────────────────┘
```

### Two ways to connect

1. **Bridge (recommended, AA-5).** The outside agent's machine runs the Octant
   CLI: `octant agent mcp --connection <file>` is the same stdio MCP server a
   client already knows, but it forwards every JSON-RPC message to the host's
   agent endpoint instead of answering locally. The connection file holds the
   host origin, its certificate pin, the grant id, and an agent key pair made on
   that machine. Each request is signed, as a paired device's is, so nothing
   replayable crosses the network and no public certificate is needed. Any MCP
   client that can start a command works.
2. **Direct (AA-6).** For an MCP client that only speaks Streamable HTTP, the
   host serves the same endpoint with a bearer agent key. Generic clients do not
   pin a self-made certificate, so direct access needs a certificate the client
   trusts: the listener's Tailscale certificate
   ([Hub and spokes](hub-and-spokes.md), H14), which the person turns on after
   the certificate-transparency note. Direct access is off per grant until the
   person chooses it, because a bearer key can be replayed by whoever holds it.

### Enrolling an agent

1. In **Settings › Remote access › Agent access**, or with
   `octant agent-access create <name> --project <name>…`, the person makes a
   grant and chooses its scope (section 4). This is local-window or loopback CLI
   only, like pairing.
2. For a bridge, Octant shows a one-time connection code
   (`octant-agent-1.` + base64url of `{origin, ticketId, ticketProof, pin}`),
   valid for five minutes, the shape of the app pairing code.
3. On the agent's machine, `octant agent-access join <code> --out <file>` makes
   a P-256 key pair, claims the ticket with its public key and a label, and
   writes the connection file (mode 0600). Octant shows the claim with the key
   fingerprint, and the person confirms it in the window that made the grant,
   as pairing approval works. A claim not confirmed within the ticket's life
   lapses.
4. For direct access, the person turns it on for the grant and Octant shows the
   bearer key once (`oak_<grant>_<secret>`, 256 random bits). Only a salted hash
   is kept, in a host store beside the remote session store, never in the
   journal. **Rotate** issues a new key and voids the old one at once.

## 4. Logical design

### The outside-agent principal

An outside agent is its own principal to the agent-access layer: it is found by
its grant, journaled under its grant, and never listed as a paired device. To
the product routes it reaches, it is presented as a paired-device principal
whose device id is the grant's own scope id (`remote-device`, origin
`octant-agent-access`), dispatched through the same authenticated product
dispatch the listener uses for paired devices.

**Rationale.** Many services decide remote limits with
`principal.kind === "remote-device"`. A new principal kind would pass any such
check written as "is it a device" and fail it as "is it local" only where the
code happens to say so; presenting the agent as a device makes every existing
device clamp apply by construction, so the agent can never hold more than a
paired device does. The agent-access layer then narrows it further to its
grant before any request reaches a route. The grant's scope id is a fresh UUID
that no device holds, so nothing addressed to a device reaches an agent.

### The grant

An agent grant records:

| Field         | Values                                                                                                                       | Default                    |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| Name          | Shown on its threads and in Needs you                                                                                        | Required                   |
| Projects      | An explicit list of active Projects                                                                                          | Required for Work and Code |
| Modes         | Any of Chat, Work, Code; Chat threads it starts are filed under no Project unless one is named                               | The listed Projects' types |
| Highest level | Ask first, Accept edits, Auto, Plan, or Full access when the person chooses it for this grant; never above the Project's own | Ask first                  |
| Threads       | Its own threads only, or every thread in its Projects                                                                        | Its own                    |
| Tools         | `start_work`, `send_message`, `read_thread`, `answer_question`, `stop_turn`, `list_threads`, `list_waiting`                  | All but `answer_question`  |
| Models        | Any the host offers, or a named list                                                                                         | Any                        |
| Limits        | Running turns at once; turns per day; requests per minute                                                                    | 2; 50; 60                  |
| Expiry        | 30 days idle and at most 90 days absolute, as a paired device                                                                | 30 / 90 days               |
| Connection    | Bridge, direct, or both                                                                                                      | Bridge                     |

There is no `add_project`: binding a folder is a local-host action. A Project
leaving the list, archived, or rebound drops out of the grant at once.

### The endpoint and route surface

The private listener gains a fourth surface, `agent-access`, holding one route,
`POST /api/agent-access/mcp` (and `DELETE` to end an MCP session). It accepts
the LAN-private and Tailscale source classes; `unknown` is refused as today.
The route is the only one an outside-agent principal can reach: it is not on
`DEFAULT_AUTHENTICATED_ROUTE_MATCHES`, and a device session cannot call it.

Behind it, a server-hosted agent MCP handler answers `initialize`,
`tools/list`, and `tools/call`. Each tool runs the same thread commands the
local CLI tools send, in process, under the outside-agent principal, after two
checks:

1. **Grant check:** the tool is ticked; the Project, mode, level, and model are
   inside the grant; the thread is in scope (its own, or in its Projects); the
   limits have room. A refusal names the grant rule, never another grant or
   Project.
2. **Remote check:** the resulting product action classifies as
   remote-approvable (`classifyRemoteAction`), exactly as for a paired device.

The tool definitions and argument schemas move to
`@octant/contracts/agent-access`, so the host endpoint and the local
`octant agent mcp` describe the same tools; each keeps its own runtime.

### Credentials on each request

- **Bridge:** every request carries `x-octant-agent-proof:
v1.<grant>.<time>.<nonce>.<signature>`, a P-256 signature over the method,
  path, body digest, time, nonce, and the host id, with 30-second skew and a
  nonce table, the pattern of `x-octant-hub-link`. MCP requests are few and
  small, so there is no session round.
- **Direct:** `Authorization: Bearer oak_…` over TLS. The host compares the
  hash in constant time and answers every failure with the same
  `unauthorized`, whatever the reason.

### What an outside agent sees

`read_thread` returns the newest turns' prompts and replies, open questions,
and what waits on the person, for threads in scope only. The host's Needs you
list answers local windows only, so for an outside agent "what waits" comes
from the thread's harness session (its pending approvals) and is reported as
incomplete, never as nothing waiting. It never returns file
contents, diffs, terminal output, credentials, or other threads. `list_waiting`
lists only rows on threads in scope. `list_threads` lists only threads in scope.

### Approvals, questions, and outside content

- Approvals and decisions go to Needs you on every device, labeled
  "<agent name> · <thread>", and to push like any other. The agent sees that
  the thread waits on the person and nothing it could answer.
- With `answer_question` ticked, the agent may answer a harness question or a
  Chat turn's question on a thread in scope, the questions the local tool
  answers. Every other request kind is the person's.
- Every prompt an outside agent sends is journaled as outside content, so the
  thread is marked from its first turn and every rule for marked threads
  applies (host lists on marked commands, the tainted-search rules, the outside
  content note on approvals).

### Visibility

- Settings › Remote access › Agent access lists each grant: name, scope,
  connection kinds, enrolled key fingerprints, last use with source class,
  threads started, and turns today. Change and Revoke are there; a paired
  device sees the list and can revoke (`GET /api/agent-grants`,
  `POST /api/agent-grants/revoke`, action `agent-access.revoke`, journaled as
  that device). An outside agent reaches neither route.
- A thread an outside agent started shows "Started by <agent name>" in its
  pane header and on its sidebar row, read from `GET /api/agent-grants/threads`,
  which names each such thread with its grant's current name.
- Every turn an agent sent, in a thread it started or in a Project thread the
  person made, shows "Sent by <agent name>" under its prompt, and the prompt
  is announced as a message from the agent rather than "Your message". The
  host journals the turn by the id its turn record keeps, which the sender
  chooses before the send: a Code turn's operation id, a Chat turn's submission
  id, a Work turn's id. A turn start without such an id is refused, and a send
  the host refused records nothing. The label follows the prompt when the
  person forks the Code thread or branches the Chat thread: a fork's inherited
  turns are named under the thread that ran them, and a Chat branch's copied
  turns keep their submission ids. The names come with the "Started by" list
  (`GET /api/agent-grants/threads`, the newest 2,000 turns), so a renamed grant
  renames its turns.

### Revocation and expiry

Revoke, expiry, a Project leaving the grant, rotation, the listener turning
off, and a host identity rotation each void the grant's credentials in one
journaled step (generation + 1). Open MCP sessions end and in-flight requests
are cancelled through the remote request registry, as device revocation does.
Turns already running keep running, since they are the person's threads; the
revoke dialog offers **Also stop its running turns**.

A grant that narrows narrows the agent's existing threads too. Every thread in
reach, whether the agent started it or the person did in a granted Project, is
in scope only while its mode and Project are in the grant. The agent may start
a turn or send an answer only on a thread whose current access is within the
grant's highest level (Full access, and its sandbox choice, only when the
grant names it; `start_work` then accepts an explicit `full-access`, kept on
the new thread alone because a grant cannot remember a level on a Project, and
refuses it for every other grant; maintainer decision, 2026-11-13) and whose
current model
is one the grant includes; otherwise the turn is refused, and the person can
change the thread. Every prompt and answer an agent sends marks its thread as
outside content before it is sent, and nothing is sent when the mark cannot be
recorded. The running-turn limit counts turns still starting, so turns started
at the same moment cannot pass it together, and counts turns on every thread
the agent ran one on, not only the threads it started.

### Journal

Aggregate `agent-access-grant`, one stream per grant:
`agent-access.grant-created@1`, `grant-changed@1`, `key-enrolled@1`,
`key-removed@1`, `direct-key-rotated@1`, `grant-revoked@1` (by the person, at
expiry, or after 30 idle days), `thread-started@1`, and `turn-sent@1`. Events
carry the grant id, name, scope, key fingerprints, thread and turn ids, and
the deciding principal, never a key or a hash. The product events an agent's
requests cause are journaled under the paired-device principal whose device
id is the grant's scope id.

## 5. Threat model

| Threat                                     | Control                                                                                                                                                                                                             | Residual risk                                                                                                                                             |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A stolen bearer key is replayed            | Private-network source classes only; scope; limits; expiry; last use and source shown; one-step rotate and revoke. Bridge mode carries no replayable secret.                                                        | Whoever holds a direct key can act within its grant until it is revoked.                                                                                  |
| A compromised agent sends harmful prompts  | Full access only where the person chose it for the grant; below it the person answers approvals and marked-thread rules apply; prompts are outside content at every level; Projects named explicitly; spend limits. | It can spend turns and read replies of its own threads within the limits; on a Full access grant its prompts run unasked, which is what the person chose. |
| Prompt injection exfiltrates through reads | Reads cover only threads in scope and only replies, questions, and waiting rows; no files, diffs, or terminal output.                                                                                               | A reply the agent itself caused can contain what the thread read.                                                                                         |
| The agent widens its own authority         | Grants are created and widened only from a local window or loopback CLI; no administrative route is on the surface; identity in the payload is refused.                                                             | None known.                                                                                                                                               |
| Host impersonation                         | Bridge pins the listener certificate from the connection code; direct mode relies on the Tailscale certificate.                                                                                                     | Direct mode trusts the tailnet name's public certificate.                                                                                                 |
| Guessing keys or tickets                   | 256-bit keys; five-minute single-use tickets with five failures; per-source budgets like pairing; one `unauthorized` for every failure.                                                                             | None known.                                                                                                                                               |
| Approval flooding                          | Running turns and turns per day are capped per grant; each pending request names the agent, and revoking it stops new ones.                                                                                         | The person still sees the requests already raised.                                                                                                        |

## 6. Decisions

| ID    | Decision                                                                                                                                                                                                                                                       | Status   |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| AA-1  | An outside agent is its own principal, found and journaled by its grant; product routes see it as a paired-device principal with the grant's scope id.                                                                                                         | Approved |
| AA-2  | Its authority is an agent grant: named Projects, modes, highest level (Full access when the person chooses it for the grant), tools, models, limits, and expiry, inside the clamps of a restricted device session. Its prompts stay marked as outside content. | Approved |
| AA-3  | Grants are created and widened only from a local window or the loopback CLI; a paired device may view and revoke.                                                                                                                                              | Approved |
| AA-4  | The only route an outside agent reaches is `POST /api/agent-access/mcp` on a new listener surface; the tools run in process under the principal.                                                                                                               | Approved |
| AA-5  | The bridge (`octant agent mcp --connection`) is the recommended connection: a key pair made on the agent's machine, signed requests, pinned TLS.                                                                                                               | Approved |
| AA-6  | Direct Streamable HTTP with a bearer key is opt-in per grant and needs the listener's Tailscale certificate.                                                                                                                                                   | Approved |
| AA-7  | No `add_project` and no approvals: binding folders and answering approvals stay with the person.                                                                                                                                                               | Approved |
| AA-8  | Prompts from an outside agent are outside content; its threads are marked from the first turn.                                                                                                                                                                 | Approved |
| AA-9  | Revocation voids credentials at once and ends sessions and in-flight requests; running turns continue unless the person also stops them.                                                                                                                       | Approved |
| AA-10 | Spend limits per grant: running turns at once, turns per day, requests per minute.                                                                                                                                                                             | Approved |
| AA-11 | Reach stays on the person's own network; hosted bots on the public internet are not supported.                                                                                                                                                                 | Approved |

### AA-11: reach from the public internet (decided: option 1)

A bot hosted by someone else (a cloud chat assistant) cannot join the person's
LAN or tailnet, so nothing above reaches it. Allowing it would change the
Principles line "Remote access is host-to-device over the user's own network",
which needs the maintainer's explicit decision. The choices:

1. **Keep reach private (the default this design assumes).** Hosted bots are
   not supported; a bot the person runs on their own machine or tailnet is.
2. **Person-operated public ingress for the agent endpoint only.** The person
   exposes `/api/agent-access/mcp` through a tunnel they operate (for example
   Tailscale Funnel). A new source class, `public-ingress`, is accepted only on
   the agent-access surface, only for grants marked public, with tighter limits
   and direct mode only; pairing and every other surface still refuse it. Still
   nothing Octant operates.
3. **Octant-operated relay.** Out: it contradicts CON-1.

Decision (2026-11-11, maintainer): option 1. Option 2 would need a new
maintainer decision and its own threat review.

## 7. Build plan

1. **Grants:** contracts (principal arm, grant schema, events, tool schemas),
   journal aggregate and projection, Settings › Agent access, and
   `octant agent-access create|list|show|change|revoke`. No reach yet.
2. **Endpoint:** the `agent-access` listener surface, the server-hosted MCP
   handler, grant and remote checks, limits, outside-content marking, journal
   attribution, revocation through the request registry. Escape tests: an
   outside agent calling every forwarded product route, an administrative
   route, a Project outside its grant, a level above its grant's highest, an approval answer, and an
   identity smuggled in the payload.
3. **Bridge:** connection codes, `octant agent-access join`, signed requests,
   and `octant agent mcp --connection`.
4. **Direct:** bearer keys, rotate, and the Tailscale-certificate requirement.
5. **Visibility:** "Started by" on threads and in Needs you, the paired-device
   view and revoke, push labels.
   Option 2 of AA-11 is not planned.

## 8. Verification (per slice)

- Grant and remote checks: focused tests that each grant field refuses what it
  excludes, and that the outside-agent principal is refused every
  `LOCAL_HOST_ACTIONS` action and every route off its surface.
- The escape suite gains an `overreaching-outside-agent` fixture next to
  `overreaching-remote-client`.
- A live smoke on two machines on one tailnet: enroll by bridge, start a Code
  thread in a granted Project, see its approval on the phone, revoke mid-turn.
- Journal checks: no agent key or hash appears in any event or log.
