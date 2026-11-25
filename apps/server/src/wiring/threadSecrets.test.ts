import {
  decodeCodeThread,
  decodeWindowId,
  decodeWorkThread,
  type CodeThread,
  type ProviderExecutionPolicy,
  type WorkThread,
} from "@octant/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureSandboxRestrictionsAuthority,
  type SandboxRestrictionsAuthority,
} from "../process/sandboxRuntimePolicy";
import { holdSecretValue } from "../process/secretRedaction";
import { ThreadSecretService, type ThreadSecretCaller } from "../threadSecrets/threadSecretService";
import { codeThreadSecrets, workThreadSecrets, type ThreadSecretTurnFacts } from "./threadSecrets";

const now = "2026-11-24T12:00:00.000Z";
const windowId = decodeWindowId("92000000-0000-4000-8000-000000000001");
const base = {
  id: "92000000-0000-4000-8000-000000000002",
  projectId: "92000000-0000-4000-8000-000000000003",
  bindingRevisionId: "92000000-0000-4000-8000-000000000004",
  title: "Publish",
  lifecycle: "active",
  providerInstanceId: "92000000-0000-4000-8000-000000000005",
  modelId: "model-a",
  version: 1,
  createdAt: now,
  updatedAt: now,
};
const codeThread = (over: Record<string, unknown> = {}): CodeThread =>
  decodeCodeThread({
    ...base,
    repositoryId: `repo_${"a".repeat(64)}`,
    checkoutId: "92000000-0000-4000-8000-000000000006",
    executionPolicy: "approval-gated",
    permissionPersistence: "current-session",
    deliveryTarget: {
      branchIntent: "feature/publish",
      remoteName: "origin",
      proposedBaseRepository: "octant/octant",
      proposedBaseBranch: "main",
      outcomeKind: "local-implementation",
      confirmedAt: now,
    },
    ...over,
  });
const workThread = (over: Record<string, unknown> = {}): WorkThread =>
  decodeWorkThread({ ...base, ...over });

const services: ThreadSecretService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.close();
  configureSandboxRestrictionsAuthority(undefined);
});

function setup(over: Partial<Omit<ThreadSecretTurnFacts, "service">> = {}) {
  const service = new ThreadSecretService({
    uuid: () => crypto.randomUUID(),
    now: () => 0,
    journal: { record: () => undefined, history: () => ({ open: [], lastLifetimes: new Map() }) },
    hold: holdSecretValue,
  });
  services.push(service);
  const request = vi
    .spyOn(service, "request")
    .mockImplementation(async () => ({ status: "refused", failure: "unavailable", note: "" }));
  const facts: ThreadSecretTurnFacts = {
    service,
    composition: undefined,
    resolveStrict: () => false,
    keepsSandbox: () => false,
    isHarnessProvider: () => false,
    windowCurrent: () => true,
    platform: "darwin",
    ...over,
  };
  const state = {
    code: codeThread() as CodeThread | undefined,
    work: workThread() as WorkThread | undefined,
    posture: "approval-gated" as ProviderExecutionPolicy,
  };
  const offer = {
    code: (routineRun = false) =>
      codeThreadSecrets(facts, {
        windowId,
        thread: codeThread(),
        readThread: () => state.code,
        folders: ["/project"],
        routineRun,
      }),
    work: (routineRun = false) =>
      workThreadSecrets(facts, {
        windowId,
        thread: workThread(),
        readThread: () => state.work,
        projectRoot: "/project",
        turnId: "turn",
        routineRun,
        posture: () => state.posture,
      }),
  };
  /** What the service would be told about the thread when the agent asks. */
  const asked = async (mode: "code" | "work") => {
    const operations = offer[mode]();
    const reply = await operations?.requestSecret({
      operation: "request-secret",
      name: "TOKEN",
      label: "Deploy token",
      kind: "token",
      reason: "Publish.",
      delivery: "file",
    });
    const caller = request.mock.calls.at(-1)?.[0] as ThreadSecretCaller | undefined;
    return { reply, caller, operations };
  };
  return { state, offer, asked, request };
}

describe("thread secrets in a Code or Work turn", () => {
  it.each(["code", "work"] as const)(
    "keeps the tool in Plan and refuses its use there (%s)",
    async (mode) => {
      const { state, asked, request } = setup();
      state.code = codeThread({ executionPolicy: "plan" });
      state.posture = "plan";
      const { reply, operations } = await asked(mode);
      expect(operations).toBeDefined();
      expect(reply).toMatchObject({ isError: true });
      expect(request).not.toHaveBeenCalled();
    },
  );

  it.each(["code", "work"] as const)(
    "offers nothing where nobody could answer the card (%s)",
    (mode) => {
      expect(setup().offer[mode](true)).toBeUndefined();
      expect(setup({ windowCurrent: () => false }).offer[mode]()).toBeUndefined();
      const gone = setup();
      gone.state.code = undefined;
      gone.state.work = undefined;
      expect(gone.offer[mode]()).toBeUndefined();
    },
  );

  it("offers nothing to a profile that does not allow the tool", () => {
    const { state, offer } = setup();
    state.code = codeThread({ toolConstraints: ["octant_canvas"] });
    expect(offer.code()).toBeUndefined();
    state.code = codeThread({ toolConstraints: ["octant_credential"] });
    expect(offer.code()).toBeDefined();
  });

  it.each([
    ["is archived", { lifecycle: "archived" }],
    ["moves to another provider", { providerInstanceId: "92000000-0000-4000-8000-000000000009" }],
    ["changes its model", { modelId: "model-b" }],
    ["is bound to another folder", { bindingRevisionId: "92000000-0000-4000-8000-000000000009" }],
  ])("has no authority once its thread %s", async (_name, over) => {
    const { state, asked } = setup();
    const code = (await asked("code")).caller;
    const work = (await asked("work")).caller;
    expect(code?.authority()).toMatchObject({ mode: "code" });
    expect(work?.authority()).toMatchObject({ mode: "work" });
    state.code = codeThread(over);
    state.work = workThread(over);
    expect(code?.authority()).toBeUndefined();
    expect(work?.authority()).toBeUndefined();
  });

  it.each(["code", "work"] as const)("has no authority after its turn ends (%s)", async (mode) => {
    const { caller, operations } = await setup().asked(mode);
    operations?.close();
    expect(caller?.authority()).toBeUndefined();
    expect(caller?.signal.aborted).toBe(true);
  });

  it.each(["code", "work"] as const)(
    "names no file where the thread's commands are confined (%s)",
    async (mode) => {
      const confined = async (
        over: Parameters<typeof setup>[0],
        posture: ProviderExecutionPolicy = "approval-gated",
      ) => {
        const host = setup(over);
        host.state.code = codeThread({ executionPolicy: posture });
        host.state.posture = posture;
        return (await host.asked(mode)).caller?.authority()?.commandsConfined;
      };
      expect(await confined({})).toBe(false);
      expect(await confined({ resolveStrict: () => true })).toBe(true);
      expect(await confined({ keepsSandbox: () => true })).toBe(true);
      const harness = { isHarnessProvider: () => true };
      expect(await confined(harness)).toBe(true);
      expect(await confined(harness, "full-access")).toBe(false);
      // The Harness runs a Windows command in no sandbox of its own.
      expect(await confined({ ...harness, platform: "win32" })).toBe(false);
      // A policy whose folder changed identity cannot be read: still confined.
      configureSandboxRestrictionsAuthority({
        active: () => {
          throw new Error("changed");
        },
      } as unknown as SandboxRestrictionsAuthority);
      expect(await confined({})).toBe(true);
    },
  );
});
