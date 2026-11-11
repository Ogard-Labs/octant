# Agent access from other machines

Status: Proposed (2026-11-11). Becomes approved when the maintainer merges it,
except AA-11 (reach from the public internet), which stays open until the
maintainer decides it on its own.
Size: Full: a new remote principal, a credential, a listener surface, a
server-hosted MCP endpoint, Settings, and a CLI enrollment step.
Owner: maintainer · Started: 2026-11-11
Build status: designed, not built. Nothing below is in force until a slice
lands and moves its rule into its owner
([Architecture: Security and authority](../architecture.md#security-and-authority))
and into [Decisions and requirements](decisions.md).

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

| ID    | Requirement                                                                                                                                                                                                                     |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-1  | An outside agent on another machine on the person's private network can start a Chat, Work, or Code thread in a Project its grant names, send further prompts, read the result, answer the thread's questions, and stop a turn. |
| FR-2  | Telling a bot "open an agent in my repo in Octant and fix x" works with one tool call, as it does locally (`start_work` with a Project).                                                                                        |
| FR-3  | The person creates a grant, sees every grant with its last use, and revokes or changes it from a local window or the CLI; a paired device can see and revoke grants but not create or widen them.                               |
| FR-4  | Approvals and other requests a thread raises wait on the person in Octant's Needs you list, named as coming from the agent's thread, and reach the person's phone like any other.                                               |
| SEC-1 | An outside agent never exceeds its grant, and the grant never exceeds what a paired device may do: no Full access, no remembered answers, no approvals, no administration, no terminals, no host Browser.                       |
| SEC-2 | Every mutation is journaled with the outside-agent principal; no agent key or secret enters the journal.                                                                                                                        |
| SEC-3 | Revocation takes effect on the next request and ends open sessions and in-flight requests, as device revocation does.                                                                                                           |
| SEC-4 | Reach stays on the person's own network: LAN-private and Tailscale source classes only. Nothing is operated by Octant (AA-11 decides anything wider).                                                                           |
| SEC-5 | Prompts from an outside agent are outside content: the thread is marked from its first turn, as a thread that read outside content is.                                                                                          |
| NFR-1 | Spend is bounded per grant: running turns at once, turns per day, and request rate.                                                                                                                                             |
| CON-1 | No Octant-operated relay, account, or service (Principles; [Current Release Boundary](../architecture.md#current-release-boundary)).                                                                                            |
| CON-2 | Remote transport and authority are host concerns, not a plugin seam: like the listener and the relay connector, agent access is host transport ([Hosted relay](hosted-relay.md) states the same for its connector).             |

Out of scope: outside agents answering approvals, choosing Full access, adding
or binding Projects, reading credentials, changing settings, administering the
listener, pairing, or other grants; agent-to-agent work between hosts (that is
[Hub and spokes](hub-and-spokes.md)); and any path over the public internet
until AA-11 is decided.

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

1. In **Settings › Agent access**, or with
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
   is kept. **Rotate** issues a new key and voids the old one at once.

## 4. Logical design

### The outside-agent principal

`RemoteClientPrincipal` gains a third arm,
`outside-agent {hostId, grantId, grantGeneration, credential: "bridge" | "direct", sourceClass, sessionId}`,
and `AuditActingPrincipal` gains `outside-agent`. It is a remote principal: every
rule a paired device lives under applies (`authorizePrincipalAction`, no local
receipts, identity refused in the payload), and then the grant narrows it
further. Its service scope is `decodeWindowId(grantId)`, as a device's is
`decodeWindowId(deviceId)`; it registers no window and binds no workspace.

### The grant

An agent grant records:

| Field         | Values                                                                                                      | Default                    |
| ------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------- |
| Name          | Shown on its threads and in Needs you                                                                       | Required                   |
| Projects      | An explicit list of active Projects                                                                         | Required for Work and Code |
| Modes         | Any of Chat, Work, Code; Chat threads it starts are filed under no Project unless one is named              | The listed Projects' types |
| Highest level | Ask first, Accept edits, Auto, or Plan; never Full access, and never above the Project's own                | Ask first                  |
| Threads       | Its own threads only, or every thread in its Projects                                                       | Its own                    |
| Tools         | `start_work`, `send_message`, `read_thread`, `answer_question`, `stop_turn`, `list_threads`, `list_waiting` | All but `answer_question`  |
| Models        | Any the host offers, or a named list                                                                        | Any                        |
| Limits        | Running turns at once; turns per day; requests per minute                                                   | 2; 50; 60                  |
| Expiry        | 30 days idle and at most 90 days absolute, as a paired device                                               | 30 / 90 days               |
| Connection    | Bridge, direct, or both                                                                                     | Bridge                     |

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

- **Bridge:** header `x-octant-agent-proof` signed over method, path, body
  digest, time, nonce, and the host id, with 30-second skew and a nonce table,
  the pattern of `RemoteRequestProofV1` and `x-octant-hub-link`. A session
  token from a challenge round avoids a signature check on every byte stream,
  as device sessions do; idle 15 minutes, absolute 12 hours.
- **Direct:** `Authorization: Bearer oak_…` over TLS. The host compares the
  hash in constant time and answers every failure with the same
  `unauthorized`, whatever the reason.

### What an outside agent sees

`read_thread` returns the newest turns' prompts and replies, open questions,
and what waits on the person, for threads in scope only. It never returns file
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

- Settings › Agent access lists each grant: name, scope, connection kinds,
  enrolled key fingerprints, last use with source class, threads started, and
  turns today. Change and Revoke are there; a paired device sees the list and
  can revoke.
- A thread an outside agent started shows "Started by <agent name>" in its
  header and in the sidebar, and its turns show the agent as the sender.

### Revocation and expiry

Revoke, expiry, a Project leaving the grant, rotation, the listener turning
off, and a host identity rotation each void the grant's credentials in one
journaled step (generation + 1). Open MCP sessions end and in-flight requests
are cancelled through the remote request registry, as device revocation does.
Turns already running keep running, since they are the person's threads; the
revoke dialog offers **Also stop its running turns**.

### Journal

Aggregate `agent-access`: `agent-access.grant-created@1`,
`grant-changed@1`, `credential-enrolled@1`, `credential-rotated@1`,
`grant-revoked@1`, `grant-expired@1`. Events carry the grant id, name, scope,
key fingerprints, and the deciding principal, never a key or a hash. Thread
events an outside agent causes carry `actor: outside-agent:<grantId>`.

## 5. Threat model

| Threat                                     | Control                                                                                                                                                      | Residual risk                                                             |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| A stolen bearer key is replayed            | Private-network source classes only; scope; limits; expiry; last use and source shown; one-step rotate and revoke. Bridge mode carries no replayable secret. | Whoever holds a direct key can act within its grant until it is revoked.  |
| A compromised agent sends harmful prompts  | No Full access; the person answers approvals; prompts are outside content, so marked-thread rules apply; Projects named explicitly; spend limits.            | It can spend turns and read replies of its own threads within the limits. |
| Prompt injection exfiltrates through reads | Reads cover only threads in scope and only replies, questions, and waiting rows; no files, diffs, or terminal output.                                        | A reply the agent itself caused can contain what the thread read.         |
| The agent widens its own authority         | Grants are created and widened only from a local window or loopback CLI; no administrative route is on the surface; identity in the payload is refused.      | None known.                                                               |
| Host impersonation                         | Bridge pins the listener certificate from the connection code; direct mode relies on the Tailscale certificate.                                              | Direct mode trusts the tailnet name's public certificate.                 |
| Guessing keys or tickets                   | 256-bit keys; five-minute single-use tickets with five failures; per-source budgets like pairing; one `unauthorized` for every failure.                      | None known.                                                               |
| Approval flooding                          | Running turns and turns per day are capped per grant; each pending request names the agent, and revoking it stops new ones.                                  | The person still sees the requests already raised.                        |

## 6. Decisions

| ID    | Decision                                                                                                                                                   | Status   |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| AA-1  | An outside agent is a new remote principal, `outside-agent`, never a paired device and never the person.                                                   | Proposed |
| AA-2  | Its authority is an agent grant: named Projects, modes, highest level (never Full access), tools, models, limits, and expiry, inside paired-device clamps. | Proposed |
| AA-3  | Grants are created and widened only from a local window or the loopback CLI; a paired device may view and revoke.                                          | Proposed |
| AA-4  | The only route an outside agent reaches is `POST /api/agent-access/mcp` on a new listener surface; the tools run in process under the principal.           | Proposed |
| AA-5  | The bridge (`octant agent mcp --connection`) is the recommended connection: a key pair made on the agent's machine, signed requests, pinned TLS.           | Proposed |
| AA-6  | Direct Streamable HTTP with a bearer key is opt-in per grant and needs the listener's Tailscale certificate.                                               | Proposed |
| AA-7  | No `add_project` and no approvals: binding folders and answering approvals stay with the person.                                                           | Proposed |
| AA-8  | Prompts from an outside agent are outside content; its threads are marked from the first turn.                                                             | Proposed |
| AA-9  | Revocation voids credentials at once and ends sessions and in-flight requests; running turns continue unless the person also stops them.                   | Proposed |
| AA-10 | Spend limits per grant: running turns at once, turns per day, requests per minute.                                                                         | Proposed |
| AA-11 | Reach from the public internet (hosted chat bots).                                                                                                         | Open     |

### AA-11: reach from the public internet (open)

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
3. **Octant-operated relay.** Out: it contradicts CON-1 and the canceled
   [Hosted relay](hosted-relay.md).

Recommendation: decide 1 now and keep 2 as a later slice, built only after the
private-network slices have been used and only on the maintainer's explicit
go-ahead, with its own threat review.

## 7. Build plan

1. **Grants:** contracts (principal arm, grant schema, events, tool schemas),
   journal aggregate and projection, Settings › Agent access, and
   `octant agent-access create|list|show|change|revoke`. No reach yet.
2. **Endpoint:** the `agent-access` listener surface, the server-hosted MCP
   handler, grant and remote checks, limits, outside-content marking, journal
   attribution, revocation through the request registry. Escape tests: an
   outside agent calling every forwarded product route, an administrative
   route, a Project outside its grant, Full access, an approval answer, and an
   identity smuggled in the payload.
3. **Bridge:** connection codes, `octant agent-access join`, signed requests,
   and `octant agent mcp --connection`.
4. **Direct:** bearer keys, rotate, and the Tailscale-certificate requirement.
5. **Visibility:** "Started by" on threads and in Needs you, the paired-device
   view and revoke, push labels.
6. **Only if AA-11 chooses option 2:** the `public-ingress` source class and
   public grants.

## 8. Verification (per slice)

- Grant and remote checks: focused tests that each grant field refuses what it
  excludes, and that the outside-agent principal is refused every
  `LOCAL_HOST_ACTIONS` action and every route off its surface.
- The escape suite gains an `overreaching-outside-agent` fixture next to
  `overreaching-remote-client`.
- A live smoke on two machines on one tailnet: enroll by bridge, start a Code
  thread in a granted Project, see its approval on the phone, revoke mid-turn.
- Journal checks: no agent key or hash appears in any event or log.
