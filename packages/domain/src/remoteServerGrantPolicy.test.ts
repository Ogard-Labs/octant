import { decodeRemoteServerGrantResult } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  decideRemoteServerGrant,
  type RemoteServerGrantDecision,
  type RemoteServerGrantFacts,
  type RemoteServerGrantListener,
} from "./remoteServerGrantPolicy";

const listed = {
  status: "listed",
  ownership: "octant-owned",
  health: "listening",
} as const satisfies RemoteServerGrantListener;

/** A paired device opening a listening, Octant-owned server in a thread it can read. */
const grantable = {
  actor: "remote-client",
  thread: { access: "readable", posture: "approval-gated" },
  listener: listed,
} as const satisfies RemoteServerGrantFacts;

const refusals: ReadonlyArray<
  readonly [title: string, facts: RemoteServerGrantFacts, expected: RemoteServerGrantDecision]
> = [
  [
    "refuses a local window, which opens the server directly",
    { ...grantable, actor: "local-user" },
    { kind: "refuse", refusal: { reason: "local-principal" } },
  ],
  [
    "refuses an agent on the host",
    { ...grantable, actor: "agent" },
    { kind: "refuse", refusal: { reason: "local-principal" } },
  ],
  [
    "refuses a thread the device cannot read",
    { ...grantable, thread: { access: "unreadable" } },
    { kind: "refuse", refusal: { reason: "thread-unreadable" } },
  ],
  [
    "answers an id the host no longer lists as not found",
    { ...grantable, listener: { status: "not-listed" } },
    { kind: "refuse", refusal: { reason: "not-found" } },
  ],
  [
    "refuses a server Octant does not own, since no confirmation can vouch for it",
    { ...grantable, listener: { ...listed, ownership: "leftover" } },
    { kind: "refuse", refusal: { reason: "not-octant-owned" } },
  ],
  [
    "refuses an Octant-owned server in the Project folder, which belongs to no thread",
    { actor: "remote-client", listener: listed },
    { kind: "refuse", refusal: { reason: "not-in-thread" } },
  ],
  [
    "refuses a server that holds its port without answering",
    { ...grantable, listener: { ...listed, health: "unresponsive" } },
    { kind: "refuse", refusal: { reason: "not-listening", health: "unresponsive" } },
  ],
  [
    "refuses a server whose health the host never determined",
    { ...grantable, listener: { ...listed, health: "unknown" } },
    { kind: "refuse", refusal: { reason: "not-listening", health: "unknown" } },
  ],
  // The order of the rules is itself authority: these cases each break two
  // rules and must answer with the earlier one.
  [
    "tells a local window nothing about the server it named",
    { actor: "local-user", listener: { status: "not-listed" } },
    { kind: "refuse", refusal: { reason: "local-principal" } },
  ],
  [
    "tells a device that cannot read the thread nothing about the ids listed in it",
    { ...grantable, thread: { access: "unreadable" }, listener: { status: "not-listed" } },
    { kind: "refuse", refusal: { reason: "thread-unreadable" } },
  ],
  [
    "refuses a server Octant does not own in the Project folder for its ownership",
    {
      actor: "remote-client",
      listener: { status: "listed", ownership: "leftover", health: "listening" },
    },
    { kind: "refuse", refusal: { reason: "not-octant-owned" } },
  ],
];

describe("remote server grant policy", () => {
  it.each(refusals)("%s", (_title, facts, expected) => {
    expect(decideRemoteServerGrant(facts)).toEqual(expected);
  });

  it.each(["full-access", "auto-accept-edits", "approval-gated", "plan"] as const)(
    "grants a paired device a listening Octant-owned server in a readable %s thread",
    (posture) => {
      expect(
        decideRemoteServerGrant({ ...grantable, thread: { access: "readable", posture } }),
      ).toEqual({ kind: "grant" });
    },
  );

  it("states every refusal it can decide in the wire result", () => {
    for (const [, facts] of refusals) {
      const decision = decideRemoteServerGrant(facts);
      if (decision.kind !== "refuse") throw new Error("expected a refusal");
      expect(
        decodeRemoteServerGrantResult({
          kind: "remote-server-grant-refused",
          requestId: "33333333-3333-4333-8333-333333333333",
          refusal: { ...decision.refusal, message: "Refused." },
        }).kind,
      ).toBe("remote-server-grant-refused");
    }
  });
});
