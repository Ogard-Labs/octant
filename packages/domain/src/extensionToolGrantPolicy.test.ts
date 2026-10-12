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
    planTurn: false,
    threadTainted: false,
    reach: "network",
    offered: seen,
    grant: { ...seen, revoked: false },
    ...overrides,
  };
}

describe("remembered MCP tool approval", () => {
  it("covers a call to the tool the person approved, exactly as they saw it", () => {
    expect(decideExtensionToolGrant(facts())).toEqual({ kind: "covered" });
  });

  it("asks, and offers to remember, when the Project holds no grant for the tool", () => {
    expect(decideExtensionToolGrant(facts({ grant: undefined }))).toEqual({
      kind: "ask",
      reason: "not-granted",
      rememberable: true,
    });
  });

  it("asks once only on a thread with no Project, where nothing can be remembered", () => {
    expect(decideExtensionToolGrant(facts({ inProject: false }))).toEqual({
      kind: "ask",
      reason: "no-project",
      rememberable: false,
    });
  });

  it("asks on a Plan turn even when the Project holds a grant", () => {
    expect(decideExtensionToolGrant(facts({ planTurn: true }))).toEqual({
      kind: "ask",
      reason: "plan-turn",
      rememberable: false,
    });
  });

  it("asks again after the grant was revoked", () => {
    expect(decideExtensionToolGrant(facts({ grant: { ...seen, revoked: true } }))).toEqual({
      kind: "ask",
      reason: "revoked",
      rememberable: true,
    });
  });

  it.each([
    ["package version", { version: "1.3.0" }],
    ["package digest", { digest: `sha256:${"c".repeat(64)}` }],
  ] as const)("asks again when the %s changed since the approval", (_name, changed) => {
    expect(decideExtensionToolGrant(facts({ offered: { ...seen, ...changed } }))).toEqual({
      kind: "ask",
      reason: "package-changed",
      rememberable: true,
    });
  });

  it("asks again when the tool's description or input schema changed since the approval", () => {
    expect(
      decideExtensionToolGrant(
        facts({ offered: { ...seen, definitionDigest: `sha256:${"d".repeat(64)}` } }),
      ),
    ).toEqual({ kind: "ask", reason: "tool-definition-changed", rememberable: true });
  });

  it("keeps a grant for a confined stdio tool on a thread that took in outside content", () => {
    expect(
      decideExtensionToolGrant(facts({ threadTainted: true, reach: "confined-stdio" })),
    ).toEqual({ kind: "covered" });
  });

  it("asks for every call of a network tool on a thread that took in outside content", () => {
    expect(decideExtensionToolGrant(facts({ threadTainted: true, reach: "network" }))).toEqual({
      kind: "ask",
      reason: "network-tool-on-tainted-thread",
      rememberable: false,
    });
    expect(
      decideExtensionToolGrant(facts({ threadTainted: true, reach: "network", grant: undefined })),
    ).toEqual({ kind: "ask", reason: "network-tool-on-tainted-thread", rememberable: false });
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
