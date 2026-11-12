import { describe, expect, it } from "vitest";
import {
  decideExtensionToolGrant,
  extensionToolGrantRevocationReason,
  type ExtensionToolGrantFacts,
} from "./extensionToolGrantPolicy";

const seen = {
  version: "1.2.0",
  digest: `sha256:${"a".repeat(64)}`,
  definitionDigest: `sha256:${"b".repeat(64)}`,
} as const;

function facts(overrides: Partial<ExtensionToolGrantFacts> = {}): ExtensionToolGrantFacts {
  return {
    inProject: true,
    hostOwnedTurn: false,
    pairedDeviceTurn: false,
    planTurn: false,
    fullAccessTurn: false,
    threadTainted: false,
    reach: "network",
    offered: seen,
    grant: { ...seen, revoked: false },
    serverGrant: undefined,
    serverAllowedOnMarkedThread: false,
    ...overrides,
  };
}

describe("remembered MCP tool approval", () => {
  it("covers a call to the tool the person approved, exactly as they saw it", () => {
    expect(decideExtensionToolGrant(facts())).toEqual({ kind: "covered" });
  });

  it("asks once for a server: the answer to a first use covers every tool of the server", () => {
    expect(decideExtensionToolGrant(facts({ grant: undefined }))).toEqual({
      kind: "ask",
      reason: "not-granted",
      answerCovers: "server",
    });
  });

  it("offers to remember for the account on a thread with no Project, and uses that grant", () => {
    expect(decideExtensionToolGrant(facts({ inProject: false, grant: undefined }))).toEqual({
      kind: "ask",
      reason: "not-granted",
      answerCovers: "server",
    });
    expect(decideExtensionToolGrant(facts({ inProject: false }))).toEqual({ kind: "covered" });
  });

  it("covers every tool of a server the person allowed whole, whatever the tool's listing", () => {
    const serverGrant = { version: seen.version, digest: seen.digest, revoked: false };
    expect(decideExtensionToolGrant(facts({ grant: undefined, serverGrant }))).toEqual({
      kind: "covered",
    });
    expect(
      decideExtensionToolGrant(
        facts({
          grant: { ...seen, definitionDigest: `sha256:${"d".repeat(64)}`, revoked: true },
          serverGrant,
        }),
      ),
    ).toEqual({ kind: "covered" });
  });

  it("asks again for a server allowed whole once its package was updated or the grant revoked", () => {
    const serverGrant = { version: seen.version, digest: seen.digest, revoked: false };
    expect(
      decideExtensionToolGrant(
        facts({ grant: undefined, serverGrant: { ...serverGrant, version: "1.3.0" } }),
      ),
    ).toEqual({ kind: "ask", reason: "package-changed", answerCovers: "server" });
    expect(
      decideExtensionToolGrant(
        facts({ grant: undefined, serverGrant: { ...serverGrant, revoked: true } }),
      ),
    ).toEqual({ kind: "ask", reason: "revoked", answerCovers: "server" });
  });

  it("asks on a Plan turn and for a network tool on a tainted thread though the server is allowed whole", () => {
    const serverGrant = { version: seen.version, digest: seen.digest, revoked: false };
    expect(decideExtensionToolGrant(facts({ planTurn: true, serverGrant }))).toMatchObject({
      kind: "ask",
      reason: "plan-turn",
    });
    expect(decideExtensionToolGrant(facts({ threadTainted: true, serverGrant }))).toMatchObject({
      kind: "ask",
      reason: "network-tool-on-tainted-thread",
    });
  });

  it("asks on a Plan turn even when the Project holds a grant", () => {
    expect(decideExtensionToolGrant(facts({ planTurn: true }))).toEqual({
      kind: "ask",
      reason: "plan-turn",
      answerCovers: "call",
    });
  });

  it("runs a tool unasked at Full access when the Project holds no grant", () => {
    expect(decideExtensionToolGrant(facts({ fullAccessTurn: true, grant: undefined }))).toEqual({
      kind: "covered",
    });
  });

  it("runs a network tool unasked at Full access on a thread that read outside content", () => {
    expect(
      decideExtensionToolGrant(
        facts({ fullAccessTurn: true, threadTainted: true, grant: undefined }),
      ),
    ).toEqual({ kind: "covered" });
  });

  it("runs a tool unasked at Full access on a host-owned or paired-device turn", () => {
    expect(
      decideExtensionToolGrant(
        facts({ fullAccessTurn: true, hostOwnedTurn: true, grant: undefined }),
      ),
    ).toEqual({ kind: "covered" });
    expect(
      decideExtensionToolGrant(
        facts({ fullAccessTurn: true, pairedDeviceTurn: true, grant: undefined }),
      ),
    ).toEqual({ kind: "covered" });
  });

  it("still asks on a Plan turn of a Full access thread", () => {
    expect(decideExtensionToolGrant(facts({ fullAccessTurn: true, planTurn: true }))).toEqual({
      kind: "ask",
      reason: "plan-turn",
      answerCovers: "call",
    });
  });

  it("still asks on a thread with no Project, which has no Full access level", () => {
    expect(
      decideExtensionToolGrant(facts({ fullAccessTurn: true, inProject: false, grant: undefined })),
    ).toEqual({ kind: "ask", reason: "not-granted", answerCovers: "server" });
  });

  it("lets a host-owned turn use a grant", () => {
    expect(decideExtensionToolGrant(facts({ hostOwnedTurn: true }))).toEqual({ kind: "covered" });
  });

  it.each([
    ["no grant", { grant: undefined }, "not-granted"],
    ["a revoked grant", { grant: { ...seen, revoked: true } }, "revoked"],
    ["an updated package", { offered: { ...seen, version: "1.3.0" } }, "package-changed"],
    [
      "a changed listing",
      { offered: { ...seen, definitionDigest: `sha256:${"d".repeat(64)}` } },
      "tool-definition-changed",
    ],
  ] as const)("asks a host-owned turn with %s for that call alone", (_name, changed, reason) => {
    expect(decideExtensionToolGrant(facts({ hostOwnedTurn: true, ...changed }))).toEqual({
      kind: "ask",
      reason,
      answerCovers: "call",
    });
  });

  it("lets a paired device's turn use a grant but never offers to remember its prompt", () => {
    expect(decideExtensionToolGrant(facts({ pairedDeviceTurn: true }))).toEqual({
      kind: "covered",
    });
    expect(decideExtensionToolGrant(facts({ pairedDeviceTurn: true, grant: undefined }))).toEqual({
      kind: "ask",
      reason: "not-granted",
      answerCovers: "call",
    });
  });

  it("asks again after the grant was revoked", () => {
    expect(decideExtensionToolGrant(facts({ grant: { ...seen, revoked: true } }))).toEqual({
      kind: "ask",
      reason: "revoked",
      answerCovers: "server",
    });
  });

  it.each([
    ["package version", { version: "1.3.0" }],
    ["package digest", { digest: `sha256:${"c".repeat(64)}` }],
  ] as const)("asks again when the %s changed since the approval", (_name, changed) => {
    expect(decideExtensionToolGrant(facts({ offered: { ...seen, ...changed } }))).toEqual({
      kind: "ask",
      reason: "package-changed",
      answerCovers: "server",
    });
  });

  it("keeps an approval across an update signed by the key that signed the approved version", () => {
    const key = `ed25519:${"1".repeat(64)}`;
    const updated = { ...seen, version: "1.3.0", digest: `sha256:${"c".repeat(64)}` };
    expect(
      decideExtensionToolGrant(
        facts({
          offered: { ...updated, publisherKey: key },
          grant: { ...seen, publisherKey: key, revoked: false },
        }),
      ),
    ).toEqual({ kind: "covered" });
    expect(
      decideExtensionToolGrant(
        facts({
          offered: { ...updated, publisherKey: key },
          grant: undefined,
          serverGrant: {
            version: seen.version,
            digest: seen.digest,
            publisherKey: key,
            revoked: false,
          },
        }),
      ),
    ).toEqual({ kind: "covered" });
  });

  it.each([
    ["a new signing key", `ed25519:${"2".repeat(64)}`, `ed25519:${"1".repeat(64)}`],
    ["no signing key on the update", undefined, `ed25519:${"1".repeat(64)}`],
    ["no signing key on either version", undefined, undefined],
  ] as const)("asks again after an update with %s", (_name, offeredKey, grantedKey) => {
    const offered = {
      ...seen,
      version: "1.3.0",
      ...(offeredKey === undefined ? {} : { publisherKey: offeredKey }),
    };
    const granted = grantedKey === undefined ? {} : { publisherKey: grantedKey };
    expect(
      decideExtensionToolGrant(facts({ offered, grant: { ...seen, ...granted, revoked: false } })),
    ).toEqual({ kind: "ask", reason: "package-changed", answerCovers: "server" });
    expect(
      decideExtensionToolGrant(
        facts({
          offered,
          grant: undefined,
          serverGrant: { version: seen.version, digest: seen.digest, ...granted, revoked: false },
        }),
      ),
    ).toEqual({ kind: "ask", reason: "package-changed", answerCovers: "server" });
  });

  it("still asks when a same-key update lists the tool differently", () => {
    const key = `ed25519:${"1".repeat(64)}`;
    expect(
      decideExtensionToolGrant(
        facts({
          offered: {
            ...seen,
            version: "1.3.0",
            definitionDigest: `sha256:${"d".repeat(64)}`,
            publisherKey: key,
          },
          grant: { ...seen, publisherKey: key, revoked: false },
        }),
      ),
    ).toEqual({ kind: "ask", reason: "tool-definition-changed", answerCovers: "server" });
  });

  it("asks again when the tool's description or input schema changed since the approval", () => {
    expect(
      decideExtensionToolGrant(
        facts({ offered: { ...seen, definitionDigest: `sha256:${"d".repeat(64)}` } }),
      ),
    ).toEqual({ kind: "ask", reason: "tool-definition-changed", answerCovers: "server" });
  });

  it("keeps a grant for a confined stdio tool on a thread that took in outside content", () => {
    expect(
      decideExtensionToolGrant(facts({ threadTainted: true, reach: "confined-stdio" })),
    ).toEqual({ kind: "covered" });
  });

  it("asks once for a network server on a thread that took in outside content, and that answer holds for the thread", () => {
    expect(decideExtensionToolGrant(facts({ threadTainted: true, reach: "network" }))).toEqual({
      kind: "ask",
      reason: "network-tool-on-tainted-thread",
      answerCovers: "server-on-thread",
    });
    expect(
      decideExtensionToolGrant(
        facts({ threadTainted: true, serverAllowedOnMarkedThread: true, grant: undefined }),
      ),
    ).toEqual({ kind: "covered" });
  });

  it("does not carry an answer given on a marked thread to a thread that is not marked", () => {
    expect(
      decideExtensionToolGrant(facts({ serverAllowedOnMarkedThread: true, grant: undefined })),
    ).toEqual({ kind: "ask", reason: "not-granted", answerCovers: "server" });
  });

  it("approves a host-owned or paired-device turn's prompt on a marked thread for that call alone", () => {
    for (const turn of [{ hostOwnedTurn: true }, { pairedDeviceTurn: true }]) {
      expect(decideExtensionToolGrant(facts({ threadTainted: true, ...turn }))).toEqual({
        kind: "ask",
        reason: "network-tool-on-tainted-thread",
        answerCovers: "call",
      });
    }
  });

  it("still asks a Plan turn on a marked thread whose server the person allowed there", () => {
    expect(
      decideExtensionToolGrant(
        facts({ threadTainted: true, serverAllowedOnMarkedThread: true, planTurn: true }),
      ),
    ).toEqual({ kind: "ask", reason: "plan-turn", answerCovers: "call" });
  });
});

describe("lifecycle changes that end a remembered approval", () => {
  it.each([
    [{ kind: "uninstall-package" }, "plugin-uninstalled"],
    [{ kind: "remove-skill" }, "plugin-uninstalled"],
    [{ kind: "rollback-package" }, "rolled-back"],
    [{ kind: "set-source-trust", trusted: false }, "trust-revoked"],
  ] as const)("revokes on %o", (change, reason) => {
    expect(extensionToolGrantRevocationReason(change)).toBe(reason);
  });

  it.each([
    { kind: "set-source-trust", trusted: true },
    { kind: "set-plugin-desired" },
    { kind: "set-component-desired" },
    { kind: "update-package" },
    { kind: "install-package" },
  ] as const)("leaves grants stored on %o", (change) => {
    expect(extensionToolGrantRevocationReason(change)).toBeUndefined();
  });
});
