import { describe, expect, it } from "vitest";
import { decodeTaskAccessQuery, decodeTaskAccessSnapshot } from "./taskAccess";
const subject = {
  aggregateType: "code-thread",
  aggregateId: "82000000-0000-4000-8000-000000000002",
};
const snapshot = () => ({
  kind: "task-access",
  subject,
  observedAt: "2026-11-02T21:00:00.000Z",
  standing: "active",
  selectedMode: "auto",
  effectiveContext: "unknown",
  default: { status: "unknown" },
  reviewer: { kind: "unknown", availability: "unknown" },
  runtime: {
    accountId: "82000000-0000-4000-8000-000000000010",
    modelId: "main-model",
    capabilities: [],
  },
  outsideContent: { read: true, effect: "unknown" },
  limitations: [],
});
describe("bounded descriptive task access contract", () => {
  it("keeps Code/Work reads independent of a context plan and accepts explicit unknown facts", () => {
    expect(decodeTaskAccessQuery({ subject, view: "task-access" }).subject.aggregateType).toBe(
      "code-thread",
    );
    expect(
      decodeTaskAccessQuery({
        subject: { ...subject, aggregateType: "work-thread" },
        view: "task-access",
      }).subject.aggregateType,
    ).toBe("work-thread");
    expect(decodeTaskAccessSnapshot(snapshot())).toMatchObject({
      effectiveContext: "unknown",
      default: { status: "unknown" },
      reviewer: { kind: "unknown" },
    });
  });
  it("accepts bounded Browser facts and refuses invented grants or reasons", () => {
    for (const browser of [
      { status: "unknown" },
      { status: "available", readOnly: true },
      ...["no-tool-transport", "excluded-by-thread-constraints", "host-lends-no-browser"].map(
        (reason) => ({ status: "omitted", reason }),
      ),
    ])
      expect(decodeTaskAccessSnapshot({ ...snapshot(), browser }).browser).toEqual(browser);
    for (const browser of [
      { status: "available" },
      { status: "omitted", reason: "approved" },
      { status: "unknown", approved: true },
    ])
      expect(() => decodeTaskAccessSnapshot({ ...snapshot(), browser })).toThrow();
  });
  it("rejects other subjects, forged identity/access and an accidental mutation-shaped query", () => {
    for (const aggregateType of ["chat-thread", "project", "agent-run"])
      expect(() =>
        decodeTaskAccessQuery({ subject: { ...subject, aggregateType }, view: "task-access" }),
      ).toThrow();
    for (const extra of [
      { windowId: subject.aggregateId },
      { effectiveMode: "full-access" },
      { approved: true },
      { kind: "set-mode" },
    ])
      expect(() => decodeTaskAccessQuery({ subject, view: "task-access", ...extra })).toThrow();
  });
  it("refuses private runtime/configuration fields and oversized account/messages/capability lists", () => {
    const base = snapshot();
    expect(() =>
      decodeTaskAccessSnapshot({
        ...base,
        runtime: { ...base.runtime, configuration: { secret: "no" } },
      }),
    ).toThrow();
    expect(() =>
      decodeTaskAccessSnapshot({ ...base, runtime: { ...base.runtime, diagnostic: "private" } }),
    ).toThrow();
    expect(() =>
      decodeTaskAccessSnapshot({
        ...base,
        runtime: { ...base.runtime, modelId: "x".repeat(1025) },
      }),
    ).toThrow();
    expect(() =>
      decodeTaskAccessSnapshot({
        ...base,
        reviewer: { kind: "provider", availability: "available", accountName: "a".repeat(257) },
      }),
    ).toThrow();
    expect(() =>
      decodeTaskAccessSnapshot({
        ...base,
        limitations: [{ kind: "unknown", message: "x".repeat(513), recovery: "none" }],
      }),
    ).toThrow();
    expect(() =>
      decodeTaskAccessSnapshot({
        ...base,
        runtime: {
          ...base.runtime,
          capabilities: Array.from({ length: 6 }, () => ({
            id: "approvals",
            support: "supported",
          })),
        },
      }),
    ).toThrow();
  });
  it("keeps unavailable support, unsupported capability and a needs-approval remedy distinct", () => {
    expect(
      decodeTaskAccessSnapshot({
        ...snapshot(),
        runtime: {
          ...snapshot().runtime,
          capabilities: [
            { id: "forceStop", support: "unsupported" },
            { id: "approvals", support: "unavailable" },
          ],
        },
        limitations: [
          {
            kind: "needs-approval",
            message: "The configured reviewer asks the person.",
            recovery: "provider-settings",
          },
        ],
      }).runtime.capabilities,
    ).toHaveLength(2);
  });
});
