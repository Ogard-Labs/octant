import { expect, it, vi } from "vitest";
import {
  decodeToolActionAuthority,
  decodeProviderModelId,
  decodeWindowId,
} from "@octant/contracts";
import {
  decodeBrowserSessionGrantsCommand,
  type BrowserSessionTarget,
} from "@octant/contracts/browser-session-grants";
import { BrowserSessionGrants } from "./browserSessionGrants";
import { BrowserDelegatedChildren } from "./browserDelegatedChildren";
import type { BrowserRuntimePort } from "./browserRuntimePort";

it("keeps child context authority separate and closes only its borrowed context on revocation", async () => {
  const command = decodeBrowserSessionGrantsCommand({
    kind: "review",
    grantee: { kind: "child", runId: "20000000-0000-4000-8000-000000000001" },
    profile: { kind: "personal" },
    origins: ["https://example.com"],
    durationMinutes: 15,
  });
  if (command.kind !== "review") throw Error("Expected review");
  const windowId = decodeWindowId("10000000-0000-4000-8000-000000000001");
  const target: BrowserSessionTarget = {
    grantee: command.grantee,
    label: "Read the report",
    modelId: decodeProviderModelId("example-model"),
    authority: decodeToolActionAuthority({
      hostId: "30000000-0000-4000-8000-000000000001",
      mode: "work",
      projectId: "40000000-0000-4000-8000-000000000001",
      providerInstanceId: "50000000-0000-4000-8000-000000000001",
      extension: { kind: "core" },
    }),
  };
  const runtime: BrowserRuntimePort = {
    available: async () => true,
    nativeAvailable: async () => true,
    createContext: vi.fn(async (_contextId, _policy, _signal, owner) => {
      expect(String(owner.windowId)).toBe(String(windowId));
      expect(String(owner.threadId)).toBe(
        String(command.grantee.kind === "child" ? command.grantee.runId : ""),
      );
      return "native-live" as const;
    }),
    inspectTarget: async () => ({ sensitive: false }),
    act: vi.fn(async () => ({
      url: "https://example.com",
      title: "Report",
      snapshot: "Report heading",
    })),
    closeContext: vi.fn(async () => {}),
    closeAll: vi.fn(async () => {}),
  };
  let children: BrowserDelegatedChildren | undefined;
  const grants = new BrowserSessionGrants({
    now: Date.now,
    uuid: () => crypto.randomUUID(),
    isLocalWindow: () => true,
    canReview: () => true,
    targets: () => [{ target, revision: "one" }],
    current: () => ({ target, revision: "one" }),
    profileLabel: async () => "Personal",
    record: () => {},
    onRevoked: (id) => {
      void children?.revoke(id);
    },
  });
  const record = vi.fn(() => ({ kind: "ignored" as const, reason: "not-tainting" as const }));
  children = new BrowserDelegatedChildren({
    runtime,
    grants,
    now: Date.now,
    uuid: () => crypto.randomUUID(),
    recordExternalContentIngestion: record,
  });
  const tools = children.tools({
    target,
    executionPolicy: "approval-gated",
    current: () => target,
  });
  const call = {
    name: "octant_browser",
    inputJson: JSON.stringify({
      operation: "navigate",
      url: "https://example.com/report",
      profile: "personal",
    }),
  };
  try {
    expect(await tools.execute(call)).toMatchObject({
      isError: true,
      result: { error: "browser-session-permission-required" },
    });
    expect(runtime.createContext).not.toHaveBeenCalled();
    const review = await grants.execute(windowId, command);
    if (review.kind !== "browser-session-review") throw Error(JSON.stringify(review));
    const allowed = await grants.execute(windowId, { kind: "grant", reviewId: review.reviewId });
    if (allowed.kind !== "browser-session-granted") throw Error(JSON.stringify(allowed));
    expect(await tools.execute(call)).toMatchObject({ isError: false });
    expect(runtime.createContext).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalled();
    expect(
      await tools.execute({
        name: call.name,
        inputJson: JSON.stringify({ operation: "download-save", downloadId: "d1" }),
      }),
    ).toMatchObject({ isError: true, result: { error: "transfer-needs-separate-permission" } });
    let complete = (_value: Awaited<ReturnType<BrowserRuntimePort["act"]>>) => {};
    const reading = new Promise<Awaited<ReturnType<BrowserRuntimePort["act"]>>>((resolve) => {
      complete = resolve;
    });
    vi.mocked(runtime.act).mockImplementationOnce(() => reading);
    const pending = tools.execute({
      name: call.name,
      inputJson: JSON.stringify({ operation: "snapshot" }),
    });
    try {
      await vi.waitFor(() => expect(runtime.act).toHaveBeenCalledTimes(2));
      await grants.execute(windowId, { kind: "revoke", grantId: allowed.grant.grantId });
      const answer = await pending;
      expect(answer.isError).toBe(true);
      expect(JSON.stringify(answer)).not.toContain("Report");
    } finally {
      complete({ url: "https://example.com", snapshot: "must not escape" });
    }
    await vi.waitFor(() => expect(runtime.closeContext).toHaveBeenCalledOnce());
    expect(runtime.closeAll).not.toHaveBeenCalled();
    expect(await tools.execute(call)).toMatchObject({
      isError: true,
      result: { error: "browser-session-permission-required" },
    });
  } finally {
    await tools.close?.();
    grants.close();
    await children.close();
  }
});
