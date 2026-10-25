import type { ProviderObservedState } from "@octant/contracts/providers";
import { describe, expect, it } from "vitest";
import { describeProviderRuntimeIntegration } from "./providerRuntimeIntegration";

const capabilities: ProviderObservedState["capabilities"] = {
  streaming: "supported",
  resume: "supported",
  interruption: "supported",
  approvals: "supported",
  userQuestions: "supported",
  reasoning: "supported",
  usage: "supported",
  toolActivity: "supported",
  fileChanges: "unavailable",
  diffs: "unavailable",
  taskProgress: "supported",
  nativeChildAgents: "unavailable",
  nativeAttachments: "supported",
  nativeWebResearch: "unsupported",
  appManagedTools: "supported",
  citations: "unsupported",
  harnessAutoReview: "unsupported",
};
const ready = { readiness: "ready", capabilities } as const;

describe("provider runtime integration", () => {
  it("names the transport a CLI's confirmed tools travel on and resumes its own session", () => {
    expect(describeProviderRuntimeIntegration("gemini", ready)).toEqual({
      tools: { status: "available", transport: "session-mcp-bridge" },
      activity: {
        source: "session",
        observes: ["replies", "tool-calls", "approvals", "task-progress"],
      },
      resume: "precise",
      context: { usage: "reported", compaction: "none" },
    });
    expect(describeProviderRuntimeIntegration("claude", ready)?.tools).toEqual({
      status: "available",
      transport: "sdk-tool-server",
    });
    expect(describeProviderRuntimeIntegration("codex", ready)?.tools).toEqual({
      status: "available",
      transport: "app-server-dynamic-tools",
    });
  });

  it("says a runtime that did not confirm its transport has no Octant tools, with the reason", () => {
    const refused = {
      ...ready,
      capabilities: { ...capabilities, appManagedTools: "unsupported" },
    } as const;
    expect(describeProviderRuntimeIntegration("opencode", refused)?.tools).toEqual({
      status: "unavailable",
      transport: "session-mcp-bridge",
      reason: "runtime-not-confirmed",
    });
    expect(describeProviderRuntimeIntegration("openai-compatible", refused)?.tools).toEqual({
      status: "unavailable",
      transport: "request-tool-calls",
      reason: "model-verification-required",
    });
    expect(describeProviderRuntimeIntegration("ollama", ready)?.tools).toEqual({
      status: "unavailable",
      reason: "no-transport",
    });
    expect(
      describeProviderRuntimeIntegration("kilo", {
        readiness: "checking",
        capabilities: { ...capabilities, appManagedTools: "unavailable" },
      })?.tools,
    ).toEqual({ status: "unavailable", transport: "session-mcp-bridge", reason: "not-confirmed" });
  });

  it("replays a direct endpoint's history and cannot resume a CLI that offers no resume", () => {
    expect(describeProviderRuntimeIntegration("anthropic-compatible", ready)?.resume).toBe(
      "best-effort",
    );
    expect(
      describeProviderRuntimeIntegration("kimi-code", {
        ...ready,
        capabilities: { ...capabilities, resume: "unsupported" },
      })?.resume,
    ).toBe("none");
  });

  it("says an ACP agent reports no usage and keeps a history nobody can compact", () => {
    expect(
      describeProviderRuntimeIntegration("devin", {
        ...ready,
        capabilities: { ...capabilities, usage: "unsupported" },
      })?.context,
    ).toEqual({ usage: "not-reported", compaction: "none" });
  });

  it("names who compacts: Octant for a history it plans, the runtime only where it takes the request", () => {
    expect(describeProviderRuntimeIntegration("openai-compatible", ready)?.context).toEqual({
      usage: "reported",
      compaction: "octant",
    });
    const compacts = (
      sessionCompaction: ProviderObservedState["capabilities"]["sessionCompaction"],
    ) =>
      describeProviderRuntimeIntegration("codex", {
        ...ready,
        capabilities: {
          ...capabilities,
          ...(sessionCompaction === undefined ? {} : { sessionCompaction }),
        },
      })?.context.compaction;
    expect(compacts({ chat: "unsupported", work: "unsupported", code: "supported" })).toBe(
      "runtime",
    );
    expect(compacts({ chat: "unavailable", work: "unavailable", code: "unavailable" })).toBe(
      "runtime-update-required",
    );
    expect(compacts(undefined)).toBe("none");
    expect(
      describeProviderRuntimeIntegration("kilo", {
        readiness: "checking",
        capabilities: { ...capabilities, usage: "unavailable" },
      })?.context.usage,
    ).toBe("not-confirmed");
  });

  it("observes nothing from a runtime that runs no turns here, and describes no image profile", () => {
    expect(
      describeProviderRuntimeIntegration("oh-my-pi", { readiness: "unavailable", capabilities })
        ?.activity,
    ).toEqual({ source: "none" });
    expect(describeProviderRuntimeIntegration("openai-image", ready)).toBeUndefined();
  });
});
