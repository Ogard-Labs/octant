import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { AggregateId, ToolEgressLaunchId, ToolEgressRuleId } from "@octant/contracts";
import {
  canonicalToolEgressHost,
  canonicalToolEgressRuleHost,
  decideProviderRuntimeEgress,
  decideToolEgress,
  decideToolEgressGrant,
  toolEgressRuleExpiresAt,
  toolEgressRuleLive,
  type ToolEgressGrantPrincipalKind,
  type ToolEgressLaunchFacts,
  type ToolEgressRequest,
  type ToolEgressRule,
  type ToolEgressRuleScope,
} from "./toolEgressPolicy";

const aggregateId = Schema.decodeUnknownSync(AggregateId);
const launchId = Schema.decodeUnknownSync(ToolEgressLaunchId);
const ruleId = Schema.decodeUnknownSync(ToolEgressRuleId);

const threadId = aggregateId("11111111-1111-4111-8111-111111111111");
const otherThreadId = aggregateId("22222222-2222-4222-8222-222222222222");
const childThreadId = aggregateId("33333333-3333-4333-8333-333333333333");
const projectId = aggregateId("44444444-4444-4444-8444-444444444444");
const otherProjectId = aggregateId("55555555-5555-4555-8555-555555555555");
const thisLaunch = launchId("66666666-6666-4666-8666-666666666666");
const otherLaunch = launchId("77777777-7777-4777-8777-777777777777");

const now = "2026-10-13T12:00:00.000Z";
const inAnHour = "2026-10-13T13:00:00.000Z";

let nextRule = 0;
function rule(
  scope: ToolEgressRuleScope,
  overrides: Partial<Omit<ToolEgressRule, "id" | "scope">> = {},
): ToolEgressRule {
  nextRule += 1;
  return {
    id: ruleId(`00000000-0000-4000-8000-${String(nextRule).padStart(12, "0")}`),
    scope,
    host: "registry.npmjs.org",
    port: 443,
    expiresAt: inAnHour,
    ...overrides,
  };
}

const lead: ToolEgressLaunchFacts = {
  launchId: thisLaunch,
  threadId,
  projectId,
  threadTainted: false,
};

function decide(
  rules: ReadonlyArray<ToolEgressRule>,
  options: Partial<Omit<ToolEgressRequest, "rules">> = {},
) {
  return decideToolEgress({
    launch: lead,
    destination: { host: "registry.npmjs.org", port: 443 },
    now,
    rules,
    ...options,
  });
}

const threadRule = (overrides?: Partial<Omit<ToolEgressRule, "id" | "scope">>) =>
  rule({ kind: "thread", threadId }, overrides);
const projectRule = (overrides?: Partial<Omit<ToolEgressRule, "id" | "scope">>) =>
  rule({ kind: "project", projectId }, overrides);
const callRule = (overrides?: Partial<Omit<ToolEgressRule, "id" | "scope">>) =>
  rule({ kind: "call", threadId, launchId: thisLaunch }, overrides);

describe("decideToolEgress scope", () => {
  it("allows a host through a live rule of the launch's own thread, Project, or call", () => {
    for (const granted of [threadRule(), projectRule(), callRule()]) {
      expect(decide([granted])).toEqual({
        kind: "allow",
        host: "registry.npmjs.org",
        port: 443,
        ruleId: granted.id,
        scope: granted.scope.kind,
      });
    }
  });

  it("refuses a host another thread, another Project, or another launch was allowed", () => {
    for (const elsewhere of [
      rule({ kind: "thread", threadId: otherThreadId }),
      rule({ kind: "project", projectId: otherProjectId }),
      rule({ kind: "call", threadId, launchId: otherLaunch }),
      rule({ kind: "call", threadId: otherThreadId, launchId: thisLaunch }),
    ]) {
      expect(decide([elsewhere])).toEqual({
        kind: "refuse",
        reason: "no-rule",
        host: "registry.npmjs.org",
        port: 443,
      });
    }
  });

  it("refuses with no rules at all, which is what an unreadable rule projection yields", () => {
    expect(decide([])).toMatchObject({ kind: "refuse", reason: "no-rule" });
  });

  it("matches the rule's port and no other", () => {
    expect(decide([threadRule({ port: 8443 })])).toMatchObject({ reason: "no-rule" });
    expect(
      decide([threadRule({ port: 8443 })], {
        destination: { host: "registry.npmjs.org", port: 8443 },
      }),
    ).toMatchObject({ kind: "allow", port: 8443 });
  });
});

describe("decideToolEgress host matching", () => {
  const wildcard = threadRule({ host: "*.githubusercontent.com" });

  it("matches a wildcard rule's subdomains at any depth and never its apex", () => {
    for (const host of ["raw.githubusercontent.com", "a.b.githubusercontent.com"]) {
      expect(decide([wildcard], { destination: { host, port: 443 } })).toMatchObject({
        kind: "allow",
        host,
      });
    }
    for (const host of ["githubusercontent.com", "evilgithubusercontent.com"]) {
      expect(decide([wildcard], { destination: { host, port: 443 } })).toMatchObject({
        kind: "refuse",
        reason: "no-rule",
      });
    }
  });

  it("matches an exact rule only on its own name, not its subdomains", () => {
    expect(
      decide([threadRule()], { destination: { host: "evil.registry.npmjs.org", port: 443 } }),
    ).toMatchObject({ reason: "no-rule" });
  });

  it("compares names in lowercase ASCII form without a trailing dot", () => {
    for (const host of ["REGISTRY.npmjs.ORG", "registry.npmjs.org."]) {
      expect(decide([threadRule()], { destination: { host, port: 443 } })).toMatchObject({
        kind: "allow",
        host: "registry.npmjs.org",
      });
    }
    expect(
      decide([threadRule({ host: "xn--bcher-kva.example" })], {
        destination: { host: "bücher.example", port: 443 },
      }),
    ).toMatchObject({ kind: "allow", host: "xn--bcher-kva.example" });
  });

  it("refuses an IP literal however it is spelled, before any rule is read", () => {
    const everything = [threadRule({ host: "*.example.com" }), threadRule()];
    for (const host of [
      "93.184.216.34",
      "127.0.0.1",
      "2130706433",
      "0x7f.1",
      "::1",
      "[::1]",
      "2606:4700:4700::1111",
    ]) {
      expect([host, decide(everything, { destination: { host, port: 443 } })]).toEqual([
        host,
        { kind: "refuse", reason: "ip-literal" },
      ]);
    }
  });

  it("refuses a single-label name, localhost, and a name that is not a DNS name", () => {
    for (const host of [
      "registry",
      "localhost",
      "api.localhost",
      "",
      "*.npmjs.org",
      "registry.npmjs.org/path",
      "user@registry.npmjs.org",
      "registry.npmjs.org?x",
      "registry .npmjs.org",
      "registry.npmjs.org..",
      "-bad.npmjs.org",
      "under_score.npmjs.org",
      `${"a".repeat(64)}.npmjs.org`,
      "registry.npmjs.org:443",
      "[::1]:443",
      "[registry.npmjs.org]",
    ]) {
      expect([host, decide([threadRule()], { destination: { host, port: 443 } })]).toEqual([
        host,
        { kind: "refuse", reason: "invalid-name" },
      ]);
    }
  });

  it("refuses a port outside 1 to 65535", () => {
    for (const port of [0, -1, 65_536, 443.5, Number.NaN]) {
      expect(decide([threadRule()], { destination: { host: "registry.npmjs.org", port } })).toEqual(
        { kind: "refuse", reason: "invalid-port" },
      );
    }
  });

  it("never matches a stored rule that names something a rule may not name", () => {
    for (const host of ["*.com", "*.localhost", "localhost", "127.0.0.1", "REGISTRY.npmjs.org"]) {
      expect([host, decide([threadRule({ host })])]).toEqual([
        host,
        expect.objectContaining({ kind: "refuse" }),
      ]);
    }
  });
});

describe("decideToolEgress expiry", () => {
  it("refuses as expired once now reaches expiresAt, to the millisecond", () => {
    expect(decide([threadRule({ expiresAt: "2026-10-13T12:00:00.001Z" })])).toMatchObject({
      kind: "allow",
    });
    for (const expiresAt of [now, "2026-10-13T11:59:59.999Z"]) {
      expect(decide([threadRule({ expiresAt })])).toEqual({
        kind: "refuse",
        reason: "expired",
        host: "registry.npmjs.org",
        port: 443,
      });
    }
  });

  it("allows through a live rule when an expired one names the same host", () => {
    const live = projectRule();
    expect(decide([threadRule({ expiresAt: now }), live])).toMatchObject({
      kind: "allow",
      ruleId: live.id,
    });
  });

  it("treats an unreadable expiry or clock as expired, never as live", () => {
    expect(decide([threadRule({ expiresAt: "never" })])).toMatchObject({ reason: "expired" });
    expect(decide([threadRule()], { now: "not-a-time" })).toMatchObject({ reason: "expired" });
  });
});

describe("decideToolEgress taint", () => {
  const tainted: ToolEgressLaunchFacts = { ...lead, threadTainted: true };

  it("suspends thread and Project rules on a tainted thread and keeps call rules", () => {
    expect(decide([threadRule(), projectRule()], { launch: tainted })).toMatchObject({
      kind: "refuse",
      reason: "no-rule",
    });
    const confirmed = callRule();
    expect(decide([threadRule(), projectRule(), confirmed], { launch: tainted })).toMatchObject({
      kind: "allow",
      ruleId: confirmed.id,
      scope: "call",
    });
  });

  it("reports a suspended rule as no rule rather than as expired", () => {
    expect(decide([threadRule({ expiresAt: now }), projectRule()], { launch: tainted })).toEqual({
      kind: "refuse",
      reason: "no-rule",
      host: "registry.npmjs.org",
      port: 443,
    });
  });
});

describe("decideToolEgress children", () => {
  const child: ToolEgressLaunchFacts = {
    launchId: thisLaunch,
    threadId: childThreadId,
    projectId,
    threadTainted: false,
    parent: { threadId, tainted: false },
  };

  it("lets a child reach exactly its parent's live rules and none of its own", () => {
    expect(decide([threadRule()], { launch: child })).toMatchObject({ kind: "allow" });
    expect(decide([projectRule()], { launch: child })).toMatchObject({ kind: "allow" });
    expect(decide([threadRule({ expiresAt: now })], { launch: child })).toMatchObject({
      reason: "expired",
    });
    expect(
      decide(
        [
          rule({ kind: "thread", threadId: childThreadId }),
          rule({ kind: "call", threadId: childThreadId, launchId: thisLaunch }),
          rule({ kind: "thread", threadId: otherThreadId }),
        ],
        { launch: child },
      ),
    ).toMatchObject({ reason: "no-rule" });
  });

  it("allows a child's launch through a call rule its parent's thread confirmed for that launch", () => {
    expect(decide([callRule()], { launch: child })).toMatchObject({
      kind: "allow",
      scope: "call",
    });
  });

  it("suspends the parent's standing rules when either the child or the parent is tainted", () => {
    for (const launch of [
      { ...child, threadTainted: true },
      { ...child, parent: { threadId, tainted: true } },
    ]) {
      expect(decide([threadRule(), projectRule()], { launch })).toMatchObject({
        reason: "no-rule",
      });
      expect(decide([callRule()], { launch })).toMatchObject({ kind: "allow" });
    }
  });
});

describe("decideToolEgress proposals", () => {
  it("takes no proposal input, so a proposal raised any number of times grants nothing", () => {
    const proposals = Array.from({ length: 1_000 }, () => ({
      host: "registry.npmjs.org",
      port: 443,
      attempts: 1_000,
    }));
    // A caller that smuggles proposals in beside the declared fields changes nothing.
    const request: ToolEgressRequest & { readonly proposals: unknown } = {
      launch: lead,
      destination: { host: "registry.npmjs.org", port: 443 },
      rules: [],
      now,
      proposals,
    };
    for (let attempt = 0; attempt < 100; attempt += 1) {
      expect(decideToolEgress(request)).toMatchObject({ kind: "refuse", reason: "no-rule" });
    }
  });
});

describe("canonicalToolEgressRuleHost", () => {
  it("accepts an exact name or a wildcard over a name of at least two labels", () => {
    expect(canonicalToolEgressRuleHost("Registry.NPMJS.org.")).toBe("registry.npmjs.org");
    expect(canonicalToolEgressRuleHost("*.example.com")).toBe("*.example.com");
    expect(canonicalToolEgressRuleHost("*.co.uk")).toBe("*.co.uk");
  });

  it("refuses an IP literal, localhost, a single label, or a wildcard over one label", () => {
    for (const host of [
      "127.0.0.1",
      "[::1]",
      "localhost",
      "registry",
      "*.com",
      "*.localhost",
      "*",
      "*.*.example.com",
      "a.*.example.com",
    ]) {
      expect([host, canonicalToolEgressRuleHost(host)]).toEqual([host, undefined]);
    }
  });

  it("names why a destination is not a name", () => {
    expect(canonicalToolEgressHost("0x7f.1")).toEqual({ kind: "refused", reason: "ip-literal" });
    expect(canonicalToolEgressHost("registry")).toEqual({
      kind: "refused",
      reason: "invalid-name",
    });
  });
});

describe("decideToolEgressGrant", () => {
  const principals: ReadonlyArray<ToolEgressGrantPrincipalKind> = [
    "local-window",
    "remote-device",
    "reviewer",
  ];
  const scopes: ReadonlyArray<ToolEgressRuleScope["kind"]> = ["call", "thread", "project"];

  it.each(
    principals.flatMap((principal) =>
      scopes.flatMap((scope) =>
        [false, true].map((threadTainted) => ({ principal, scope, threadTainted })),
      ),
    ),
  )("decides $principal granting a $scope rule (tainted: $threadTainted)", (input) => {
    const decision = decideToolEgressGrant(input);
    const expected =
      input.principal === "reviewer"
        ? input.threadTainted
          ? "needs-person"
          : input.scope === "call"
            ? "grant"
            : "reviewer-call-only"
        : input.threadTainted && input.scope !== "call"
          ? "thread-tainted"
          : input.scope === "project" && input.principal !== "local-window"
            ? "needs-local-window"
            : "grant";
    expect(decision.kind === "grant" ? "grant" : decision.reason).toBe(expected);
  });
});

describe("toolEgressRuleExpiresAt", () => {
  it("counts each offered lifetime from the moment of granting", () => {
    expect(toolEgressRuleExpiresAt("1h", now)).toBe(inAnHour);
    expect(toolEgressRuleExpiresAt("8h", now)).toBe("2026-10-13T20:00:00.000Z");
    expect(toolEgressRuleExpiresAt("7d", now)).toBe("2026-10-20T12:00:00.000Z");
    expect(toolEgressRuleExpiresAt("30d", now)).toBe("2026-11-12T12:00:00.000Z");
  });

  it("gives no expiry for an unreadable clock, so nothing is granted with a made-up one", () => {
    expect(toolEgressRuleExpiresAt("8h", "")).toBeUndefined();
    expect(toolEgressRuleExpiresAt("8h", "yesterday")).toBeUndefined();
  });

  it("treats a rule as dead at its expiry and when either time is unreadable", () => {
    expect(toolEgressRuleLive(inAnHour, now)).toBe(true);
    expect(toolEgressRuleLive(inAnHour, inAnHour)).toBe(false);
    expect(toolEgressRuleLive("", now)).toBe(false);
    expect(toolEgressRuleLive(inAnHour, "")).toBe(false);
  });

  it("lets a placed provider runtime reach any public name, and refuses an address, a single label, or a bad port", () => {
    expect(decideProviderRuntimeEgress({ host: "API.Example.com.", port: 443 })).toEqual({
      kind: "allow",
      host: "api.example.com",
      port: 443,
    });
    expect(decideProviderRuntimeEgress({ host: "169.254.169.254", port: 80 })).toEqual({
      kind: "refuse",
      reason: "ip-literal",
    });
    expect(decideProviderRuntimeEgress({ host: "[::1]", port: 443 })).toEqual({
      kind: "refuse",
      reason: "ip-literal",
    });
    for (const host of ["localhost", "metadata", "db.localhost"]) {
      expect(decideProviderRuntimeEgress({ host, port: 443 })).toEqual({
        kind: "refuse",
        reason: "invalid-name",
      });
    }
    expect(decideProviderRuntimeEgress({ host: "api.example.com", port: 0 })).toEqual({
      kind: "refuse",
      reason: "invalid-port",
    });
  });
});
