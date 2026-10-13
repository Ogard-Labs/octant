import { describe, expect, it } from "vitest";
import {
  MAX_TOOL_EGRESS_DECISION_BATCH_ENTRIES,
  MAX_TOOL_EGRESS_SUMMARY_ENTRIES,
  TOOL_EGRESS_EVENT_NAMES,
  TOOL_EGRESS_PROJECT_AGGREGATE,
  TOOL_EGRESS_THREAD_AGGREGATE,
  decodeProjectEgressRuleGrantedPayload,
  decodeProjectEgressRuleRevokedPayload,
  decodeThreadEgressDecisionsRecordedPayload,
  decodeThreadEgressLaunchIncompletePayload,
  decodeThreadEgressLaunchStartedPayload,
  decodeThreadEgressLaunchSummarizedPayload,
  decodeThreadEgressProposalDeclinedPayload,
  decodeThreadEgressProposalRaisedPayload,
  decodeThreadEgressRuleGrantedPayload,
  decodeThreadEgressRuleRevokedPayload,
  decodeToolEgressRuleHost,
} from "./toolEgress";

const threadId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const ruleId = "33333333-3333-4333-8333-333333333333";
const launchId = "44444444-4444-4444-8444-444444444444";
const approvalId = "55555555-5555-4555-8555-555555555555";
const deviceId = "66666666-6666-4666-8666-666666666666";
const proposalId = "77777777-7777-4777-8777-777777777777";
const expiresAt = "2026-10-13T20:00:00.000Z";

const launch = { launchId, threadId, projectId, toolCallId: "call_1" };

const threadGrant = {
  ruleId,
  threadId,
  host: "registry.npmjs.org",
  port: 443,
  scope: { kind: "thread" },
  expiresAt,
  principal: { kind: "local-window" },
  approvalId,
  threadTainted: false,
} as const;

describe("tool egress event names", () => {
  it("names every audit event the design lists, on the thread and Project egress aggregates", () => {
    expect(TOOL_EGRESS_THREAD_AGGREGATE).toBe("thread-egress");
    expect(TOOL_EGRESS_PROJECT_AGGREGATE).toBe("project-egress");
    expect(Object.values(TOOL_EGRESS_EVENT_NAMES).toSorted()).toEqual([
      "project.egress-rule-granted@1",
      "project.egress-rule-revoked@1",
      "thread.egress-decisions-recorded@1",
      "thread.egress-launch-incomplete@1",
      "thread.egress-launch-started@1",
      "thread.egress-launch-summarized@1",
      "thread.egress-proposal-declined@1",
      "thread.egress-proposal-raised@1",
      "thread.egress-rule-granted@1",
      "thread.egress-rule-revoked@1",
    ]);
  });
});

describe("ToolEgressRuleHost", () => {
  it("accepts a canonical exact name or a wildcard over at least two labels", () => {
    for (const host of [
      "registry.npmjs.org",
      "*.githubusercontent.com",
      "*.co.uk",
      "xn--bcher-kva.example",
    ]) {
      expect(decodeToolEgressRuleHost(host)).toBe(host);
    }
  });

  it("refuses an IP literal, localhost, a single label, a broad wildcard, or a non-canonical name", () => {
    for (const host of [
      "93.184.216.34",
      "::1",
      "[::1]",
      "localhost",
      "api.localhost",
      "registry",
      "*.com",
      "*.localhost",
      "*",
      "a.*.example.com",
      "Registry.npmjs.org",
      "registry.npmjs.org.",
      "bücher.example",
      "under_score.example.com",
      "-bad.example.com",
      `${"a".repeat(64)}.example.com`,
      `${"a.".repeat(127)}com`,
    ]) {
      expect(() => decodeToolEgressRuleHost(host), host).toThrow();
    }
  });
});

describe("thread egress rule grants", () => {
  it("records a thread rule a person granted, with its expiry and the approval it came from", () => {
    expect(decodeThreadEgressRuleGrantedPayload(threadGrant)).toEqual(threadGrant);
    const fromDevice = { ...threadGrant, principal: { kind: "remote-device", deviceId } };
    expect(decodeThreadEgressRuleGrantedPayload(fromDevice)).toEqual(fromDevice);
  });

  it("refuses a payload that carries a token, URL path, header, or body", () => {
    for (const extra of [
      { token: "a".repeat(64) },
      { path: "/v1/packages" },
      { url: "https://registry.npmjs.org/left-pad" },
      { headers: { authorization: "Bearer x" } },
      { body: "secrets" },
    ]) {
      expect(() => decodeThreadEgressRuleGrantedPayload({ ...threadGrant, ...extra })).toThrow();
    }
  });

  it("refuses a host and port no rule may hold", () => {
    expect(() =>
      decodeThreadEgressRuleGrantedPayload({ ...threadGrant, host: "10.0.0.1" }),
    ).toThrow();
    for (const port of [0, 65_536, 443.5]) {
      expect(() => decodeThreadEgressRuleGrantedPayload({ ...threadGrant, port })).toThrow();
    }
  });

  it("lets a reviewer or a tainted thread grant only a call rule", () => {
    const callScope = { kind: "call", launchId } as const;
    for (const grant of [
      { ...threadGrant, principal: { kind: "reviewer" } },
      { ...threadGrant, threadTainted: true },
    ]) {
      expect(() => decodeThreadEgressRuleGrantedPayload(grant)).toThrow(/Only call rules/);
      expect(decodeThreadEgressRuleGrantedPayload({ ...grant, scope: callScope })).toMatchObject({
        scope: callScope,
      });
    }
  });

  it("refuses any reviewer grant on a tainted thread, which needs a person to confirm", () => {
    for (const scope of [{ kind: "call", launchId }, { kind: "thread" }]) {
      expect(() =>
        decodeThreadEgressRuleGrantedPayload({
          ...threadGrant,
          scope,
          principal: { kind: "reviewer" },
          threadTainted: true,
        }),
      ).toThrow(/reviewer cannot grant on a tainted thread/);
    }
    expect(
      decodeThreadEgressRuleGrantedPayload({
        ...threadGrant,
        scope: { kind: "call", launchId },
        principal: { kind: "local-window" },
        threadTainted: true,
      }),
    ).toMatchObject({ threadTainted: true });
  });

  it("records a revocation with the person who made it", () => {
    const revoked = { ruleId, threadId, principal: { kind: "local-window" }, threadTainted: true };
    expect(decodeThreadEgressRuleRevokedPayload(revoked)).toEqual(revoked);
    expect(() =>
      decodeThreadEgressRuleRevokedPayload({ ...revoked, principal: { kind: "reviewer" } }),
    ).toThrow();
  });
});

describe("Project egress rule grants", () => {
  const projectGrant = {
    ruleId,
    projectId,
    threadId,
    host: "*.pypi.org",
    port: 443,
    expiresAt,
    principal: { kind: "local-window" },
    approvalId,
    threadTainted: false,
  } as const;

  it("records a Project rule a person at a local window granted on a clean thread", () => {
    expect(decodeProjectEgressRuleGrantedPayload(projectGrant)).toEqual(projectGrant);
  });

  it("refuses a Project rule from a paired device, a reviewer, or a tainted thread", () => {
    for (const grant of [
      { ...projectGrant, principal: { kind: "remote-device", deviceId } },
      { ...projectGrant, principal: { kind: "reviewer" } },
      { ...projectGrant, threadTainted: true },
    ]) {
      expect(() => decodeProjectEgressRuleGrantedPayload(grant)).toThrow();
    }
  });

  it("records a Project rule's revocation", () => {
    const revoked = { ruleId, projectId, principal: { kind: "remote-device", deviceId } };
    expect(decodeProjectEgressRuleRevokedPayload(revoked)).toEqual(revoked);
  });
});

describe("learn-mode proposals", () => {
  const raised = {
    proposalId,
    threadId,
    launch: {
      ...launch,
      threadId: "88888888-8888-4888-8888-888888888888",
      parentThreadId: threadId,
    },
    host: "files.pythonhosted.org",
    port: 443,
    reason: "no-rule",
    attempts: 3,
    threadTainted: false,
  } as const;

  it("records an exact host a child's launch was refused, on the parent's thread", () => {
    expect(decodeThreadEgressProposalRaisedPayload(raised)).toEqual(raised);
    expect(decodeThreadEgressProposalRaisedPayload({ ...raised, reason: "expired" })).toMatchObject(
      { reason: "expired" },
    );
  });

  it("refuses a proposal for a wildcard, an IP literal, or a refusal that is not proposable", () => {
    for (const proposal of [
      { ...raised, host: "*.pythonhosted.org" },
      { ...raised, host: "151.101.0.223" },
      ...(["private-destination", "ip-literal", "token", "sni-mismatch"] as const).map(
        (reason) => ({
          ...raised,
          reason,
        }),
      ),
      { ...raised, attempts: 0 },
    ]) {
      expect(() => decodeThreadEgressProposalRaisedPayload(proposal)).toThrow();
    }
  });

  it("records a decline of at least one proposal", () => {
    const declined = {
      threadId,
      proposalIds: [proposalId],
      principal: { kind: "local-window" },
      threadTainted: false,
    };
    expect(decodeThreadEgressProposalDeclinedPayload(declined)).toEqual(declined);
    expect(() =>
      decodeThreadEgressProposalDeclinedPayload({ ...declined, proposalIds: [] }),
    ).toThrow();
  });
});

describe("launch records", () => {
  const allowed = {
    host: "registry.npmjs.org",
    port: 443,
    decision: "allowed",
    requests: 2,
    bytesSent: 1_024,
    bytesReceived: 65_536,
  } as const;
  const refused = {
    host: "169.254.169.254",
    port: 80,
    decision: "refused",
    reason: "ip-literal",
    requests: 1,
  } as const;

  it("records a launch's start before it accepts a connection", () => {
    const started = { launch, startedAt: "2026-10-13T12:00:00.000Z", threadTainted: false };
    expect(decodeThreadEgressLaunchStartedPayload(started)).toEqual(started);
    expect(() =>
      decodeThreadEgressLaunchStartedPayload({ ...started, launch: { ...launch, token: "x" } }),
    ).toThrow();
  });

  it("records decisions in batches of at most sixteen entries", () => {
    const batch = { launch, entries: [allowed, refused], threadTainted: false };
    expect(decodeThreadEgressDecisionsRecordedPayload(batch)).toEqual(batch);
    expect(() =>
      decodeThreadEgressDecisionsRecordedPayload({
        ...batch,
        entries: Array.from({ length: MAX_TOOL_EGRESS_DECISION_BATCH_ENTRIES + 1 }, () => allowed),
      }),
    ).toThrow();
    expect(() => decodeThreadEgressDecisionsRecordedPayload({ ...batch, entries: [] })).toThrow();
  });

  it("requires a refused entry to name its reason and keeps paths out of the host", () => {
    const { reason: _reason, ...withoutReason } = refused;
    for (const entry of [
      withoutReason,
      { ...allowed, reason: "no-rule" },
      { ...allowed, host: "registry.npmjs.org/left-pad" },
      { ...allowed, host: "user:pass@registry.npmjs.org" },
    ]) {
      expect(() =>
        decodeThreadEgressDecisionsRecordedPayload({
          launch,
          entries: [entry],
          threadTainted: false,
        }),
      ).toThrow();
    }
  });

  it("summarizes a launch with totals and at most sixty-four entries", () => {
    const summary = {
      launch,
      endedAt: "2026-10-13T12:01:00.000Z",
      bytesSent: 1_024,
      bytesReceived: 65_536,
      entries: [allowed, refused],
      truncated: false,
      threadTainted: false,
    };
    expect(decodeThreadEgressLaunchSummarizedPayload(summary)).toEqual(summary);
    expect(() =>
      decodeThreadEgressLaunchSummarizedPayload({
        ...summary,
        entries: Array.from({ length: MAX_TOOL_EGRESS_SUMMARY_ENTRIES + 1 }, () => allowed),
        truncated: true,
      }),
    ).toThrow();
  });

  it("marks a launch the server never summarized as having an unknown tail", () => {
    const incomplete = {
      launch,
      recordedBytesSent: 0,
      recordedBytesReceived: 0,
      entries: [],
      truncated: false,
      tail: "unknown",
      threadTainted: false,
    };
    expect(decodeThreadEgressLaunchIncompletePayload(incomplete)).toEqual(incomplete);
    expect(() =>
      decodeThreadEgressLaunchIncompletePayload({ ...incomplete, tail: "complete" }),
    ).toThrow();
  });
});
