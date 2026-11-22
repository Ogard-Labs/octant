import { Schema } from "effect";
import { RosterMember } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { memberOrigin } from "./memberOrigin";

const member = (listenerPort: number | undefined) =>
  Schema.decodeUnknownSync(RosterMember)({
    memberId: "11111111-1111-4111-8111-111111111111",
    name: "Mac mini",
    role: "hub",
    identityKeyFingerprint: "a".repeat(64),
    listenerPin: "b".repeat(64),
    privateNames: [],
    addresses: ["192.168.1.20"],
    owner: false,
    ...(listenerPort === undefined ? {} : { listenerPort }),
  });

describe("a member's listener origin", () => {
  it("leaves out the HTTPS default port, as the listener's own origin does, and keeps any other", () => {
    expect(memberOrigin(member(443))).toBe("https://192.168.1.20");
    expect(memberOrigin(member(undefined))).toBe("https://192.168.1.20");
    expect(memberOrigin(member(8443))).toBe("https://192.168.1.20:8443");
  });
});
