// Reading a member's signed hello from the hub, to confirm an update made
// over SSH. The hub reaches the member's listener only over its pinned
// connection, and believes the hello only when the member's own identity key,
// the one the hub admitted it with, signed it for a nonce made for this read.

import { randomBytes } from "node:crypto";
import { decodeHostAnswer } from "@octant/contracts";
import { HOST_HELLO_CLIENT_NONCE_PARAMETER, HostHelloV1 } from "@octant/contracts/remote-access";
import type { MemberHelloReading, MemberListener } from "../shield/memberUpkeep";
import { listenerPinFromDigest } from "./hubCrypto";
import { helloIsProven } from "./hubPairing";
import type { HubStatePort } from "./hubStateStore";
import type { HubTransport } from "./pinnedHubTransport";

/** A member of this hub as the hub admitted it: where it listens, its pin, and its identity key. */
export interface HubMemberAtListener {
  readonly memberId: string;
  readonly origin: string;
  readonly pin: string;
  readonly identityKeyFingerprint: string;
}

/** The member this hub admitted whose listener is at that address and port. */
export function hubMemberAt(
  state: HubStatePort,
  listener: MemberListener,
): HubMemberAtListener | undefined {
  const hub = state.load().hub;
  if (hub?.enabled !== true || hub.roster === undefined) return undefined;
  const wanted = listener.address.toLowerCase();
  for (const record of hub.members) {
    if (record.listenerOrigin === undefined) continue;
    let url: URL;
    try {
      url = new URL(record.listenerOrigin);
    } catch {
      continue;
    }
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (host !== wanted || Number(url.port) !== listener.port) continue;
    const entry = hub.roster.roster.members.find(
      (member) => String(member.memberId) === String(record.memberId),
    );
    if (entry === undefined) continue;
    return {
      memberId: String(record.memberId),
      origin: record.listenerOrigin,
      pin: listenerPinFromDigest(entry.listenerPin),
      identityKeyFingerprint: entry.identityKeyFingerprint,
    };
  }
  return undefined;
}

export async function readMemberHello(input: {
  readonly member: HubMemberAtListener;
  readonly transport: HubTransport;
  readonly now: () => number;
}): Promise<MemberHelloReading> {
  const { member } = input;
  const clientNonce = randomBytes(32).toString("base64url");
  const url = new URL("/api/remote/hello", member.origin);
  url.searchParams.set(HOST_HELLO_CLIENT_NONCE_PARAMETER, clientNonce);
  let body: unknown;
  try {
    const response = await input.transport({ origin: member.origin, pin: member.pin })(
      url.toString(),
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!response.ok) return { status: "unreachable" };
    body = await response.json();
  } catch {
    return { status: "unreachable" };
  }
  let hello: HostHelloV1;
  try {
    hello = decodeHostAnswer(HostHelloV1)(body);
  } catch {
    return { status: "unproven" };
  }
  if (
    hello.hostKeyFingerprint !== member.identityKeyFingerprint ||
    !helloIsProven(hello, clientNonce, input.now())
  ) {
    return { status: "unproven" };
  }
  return {
    status: "read",
    buildVersion: hello.serverBuildVersion,
    protocolRange: hello.supportedProtocolRange,
  };
}
