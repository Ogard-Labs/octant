import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { decodeCodeThread, type CodeThread } from "@octant/contracts/code";
import { SshRemoteProject } from "@octant/contracts/ssh-remote-project";
import type { SshAdmissionDecision } from "@octant/contracts/ssh-target";
import { ACP_CLIENT_TERMINAL_TOOL_NAMES, ACP_CLIENT_TOOL_NAMES } from "@octant/provider-sdk";
import type { ProviderRemoteProcessPlacement } from "@octant/provider-sdk/driver";
import type { NativeHarnessComposition } from "../harness/nativeHarnessComposition";
import type {
  SshTargetPlacement,
  SshTargetPlacementInput,
  SshTargetSession,
} from "./sshTargetConnectionService";
import {
  bindRemoteCodeTurn,
  remoteCodeCheckout,
  remoteCodeProjectOf,
  targetHoldsRunningTurn,
  type RemoteCodeTurnInput,
} from "./sshRemoteCodeThreads";

const project = Schema.decodeUnknownSync(SshRemoteProject)({
  id: "71000000-0000-4000-8000-000000000001",
  name: "Remote app",
  targetId: "71000000-0000-4000-8000-000000000002",
  remoteRoot: "/home/dev/app",
  boundAt: "2026-10-27T10:00:00.000Z",
});
const store = {
  getProject: (id: string) => (id === String(project.id) ? project : undefined),
};

function threadOn(
  binding: ReturnType<typeof remoteCodeCheckout>,
  executionPolicy: CodeThread["executionPolicy"] = "approval-gated",
): CodeThread {
  return decodeCodeThread({
    id: "71000000-0000-4000-8000-000000000003",
    projectId: project.id,
    bindingRevisionId: binding.bindingRevisionId,
    repositoryId: binding.checkout.repositoryId,
    checkoutId: binding.checkout.id,
    title: "On the target",
    lifecycle: "active",
    providerInstanceId: "71000000-0000-4000-8000-000000000004",
    modelId: "model-a",
    executionPolicy,
    permissionPersistence: "current-session",
    deliveryTarget: {
      branchIntent: "main",
      remoteName: "origin",
      proposedBaseRepository: "octant/app",
      proposedBaseBranch: "main",
      outcomeKind: "local-implementation",
      confirmedAt: "2026-10-27T10:00:00.000Z",
    },
    version: 1,
    createdAt: "2026-10-27T10:00:00.000Z",
    updatedAt: "2026-10-27T10:00:00.000Z",
  });
}

const placedAt: ProviderRemoteProcessPlacement = {
  kind: "remote",
  executable: "/home/dev/.local/bin/copilot",
  launch: () => Effect.die(new Error("Nothing launches while a turn is bound.")),
};

/** Records which seams a binding reached, so a refusal can show it reached none. */
function seams(
  admission: SshAdmissionDecision = { status: "admitted" },
  placement: SshTargetPlacement = { status: "placed", placement: placedAt },
) {
  const reached: string[] = [];
  const placements: SshTargetPlacementInput[] = [];
  let posture: CodeThread["executionPolicy"] | undefined = "approval-gated";
  const session = {
    targetId: project.targetId,
    connectionId: "71000000-0000-4000-8000-0000000000aa" as SshTargetSession["connectionId"],
    onEnd: () => () => undefined,
  } satisfies SshTargetSession;
  return {
    reached,
    placements,
    setPosture: (next: CodeThread["executionPolicy"] | undefined) => {
      posture = next;
    },
    options: {
      store,
      connections: {
        admitProviderRuntime: () => {
          reached.push("admit-runtime");
          return admission;
        },
        session: () => session,
        placement: (input: SshTargetPlacementInput) => {
          reached.push("placement");
          placements.push(input);
          return placement;
        },
      },
      composition: {
        forRemoteCode: () => {
          reached.push("compose");
          return {
            status: "composed",
            tools: { definitions: [], execute: async () => ({ result: {} }) },
            release: () => undefined,
          };
        },
        remoteHandsForCode: () => {
          reached.push("hands");
          return {
            status: "bound",
            // Binding a turn runs nothing on the target.
            filesystem: {
              read: () => Promise.reject(new Error("Nothing is read while a turn is bound.")),
              write: () => Promise.reject(new Error("Nothing is written while a turn is bound.")),
            },
            shell: {
              run: () => Promise.reject(new Error("Nothing runs while a turn is bound.")),
            },
            executionPolicy: () => posture,
            release: () => {
              reached.push("release");
            },
          };
        },
      } satisfies Pick<NativeHarnessComposition, "forRemoteCode" | "remoteHandsForCode">,
      uuid: () => "71000000-0000-4000-8000-0000000000bb",
    },
  };
}

const placeable: RemoteCodeTurnInput["driver"] = {
  kind: "copilot",
  remotePlacement: {
    postures: ["plan", "approval-gated", "auto-accept-edits"],
    appToolTransport: "stdio",
  },
};

function turn(thread: CodeThread, driver: RemoteCodeTurnInput["driver"]): RemoteCodeTurnInput {
  return {
    thread,
    windowId: "71000000-0000-4000-8000-000000000005" as RemoteCodeTurnInput["windowId"],
    driver,
    secrets: [],
    onTargetDisconnected: () => undefined,
  };
}

describe("remote-bound Code threads", () => {
  it("names a Project's checkout from its binding alone, and recognizes only threads created against it", () => {
    const binding = remoteCodeCheckout(project);
    expect(binding).toEqual(remoteCodeCheckout(project));
    expect(binding.checkout).toMatchObject({ kind: "remote-root", head: { kind: "none" } });
    const thread = threadOn(binding);
    expect(remoteCodeProjectOf(store, thread)).toEqual(project);
    // The same Project id bound to another root is another checkout.
    const moved = remoteCodeCheckout({
      ...project,
      remoteRoot: project.remoteRoot.concat("2") as never,
    });
    expect(moved.checkout.id).not.toBe(binding.checkout.id);
    expect(remoteCodeProjectOf(store, threadOn(moved))).toBeUndefined();
  });

  it("finds a target in use only while a thread on one of its Projects' bindings holds a turn", () => {
    const thread = threadOn(remoteCodeCheckout(project));
    const stranger = decodeCodeThread({
      ...thread,
      id: "71000000-0000-4000-8000-0000000000cc",
      checkoutId: "71000000-0000-4000-8000-000000000009",
    });
    const running = new Set<string>([String(thread.id), String(stranger.id)]);
    const inUse = (targetId: string) =>
      targetHoldsRunningTurn(
        {
          projects: () => [project],
          threads: () => [thread, stranger],
          turnInProgress: (threadId) => running.has(threadId),
        },
        targetId,
      );
    expect(inUse(String(project.targetId))).toBe(true);
    expect(inUse("71000000-0000-4000-8000-0000000000dd")).toBe(false);
    // A thread not created against the binding names nothing on the target.
    running.delete(String(thread.id));
    expect(inUse(String(project.targetId))).toBe(false);
  });

  it("refuses a runtime that declares no placement with admission's reason, before composing anything", () => {
    const { reached, options } = seams({ status: "refused", reason: "runtime-not-attestable" });
    const bound = bindRemoteCodeTurn(
      options,
      turn(threadOn(remoteCodeCheckout(project)), { kind: "codex" }),
    );
    expect(bound).toEqual({
      status: "refused",
      message: "Octant cannot confine this runtime on an SSH target. Choose one it confines there.",
    });
    expect(reached).toEqual(["admit-runtime"]);
  });

  it("binds a placed ACP agent's turn to its client tools on the target and a placement at the person's path, in the thread's posture", () => {
    const { reached, placements, options } = seams();
    const thread = threadOn(remoteCodeCheckout(project));
    const bound = bindRemoteCodeTurn(options, turn(thread, placeable));
    if (bound.status !== "bound") throw new Error(`refused: ${bound.message}`);
    expect(bound.placement).toBe(placedAt);
    expect(bound.tools.definitions.map((definition) => definition.name)).toEqual([
      ACP_CLIENT_TOOL_NAMES.readTextFile,
      ACP_CLIENT_TOOL_NAMES.writeTextFile,
      ...ACP_CLIENT_TERMINAL_TOOL_NAMES,
    ]);
    expect(placements).toEqual([
      expect.objectContaining({
        root: project.remoteRoot,
        projectId: String(project.id),
        threadId: String(thread.id),
        providerInstanceId: thread.providerInstanceId,
        posture: "approval-gated",
        permissionPersistence: "current-session",
      }),
    ]);
    expect(placements[0]?.currentPosture()).toBe("approval-gated");
    expect(reached).toEqual(["admit-runtime", "hands", "placement"]);
    bound.release();
    expect(reached.at(-1)).toBe("release");

    // In Plan the agent is offered only the read.
    const plan = bindRemoteCodeTurn(
      seams().options,
      turn(threadOn(remoteCodeCheckout(project), "plan"), placeable),
    );
    expect(
      plan.status === "bound" ? plan.tools.definitions.map((definition) => definition.name) : plan,
    ).toEqual([ACP_CLIENT_TOOL_NAMES.readTextFile]);
  });

  it("refuses a placed agent with no runtime path set on the target, releasing the tools it bound", () => {
    const { reached, options } = seams(
      { status: "admitted" },
      {
        status: "refused",
        failure: { category: "invalid-configuration", message: "Set where this runtime is." },
      },
    );
    expect(
      bindRemoteCodeTurn(options, turn(threadOn(remoteCodeCheckout(project)), placeable)),
    ).toEqual({ status: "refused", message: "Set where this runtime is." });
    expect(reached).toEqual(["admit-runtime", "hands", "placement", "release"]);
  });

  it("refuses a runtime that could be placed but is not an ACP agent before binding anything", () => {
    // OpenCode's driver is its own server, not an ACP agent, though the ACP
    // stack has a profile of the same name.
    for (const kind of ["pi", "opencode"] as const) {
      const { reached, options } = seams();
      const bound = bindRemoteCodeTurn(
        options,
        turn(threadOn(remoteCodeCheckout(project)), {
          kind,
          remotePlacement: { postures: ["approval-gated"], appToolTransport: "stdio" },
        }),
      );
      expect(bound).toMatchObject({
        status: "refused",
        message: expect.stringContaining("only an ACP agent"),
      });
      expect(reached).toEqual(["admit-runtime"]);
    }
  });

  it("binds the harness's remote tools for a thread on its binding, and nothing for a thread that is not", () => {
    const { reached, options } = seams();
    const thread = threadOn(remoteCodeCheckout(project));
    expect(bindRemoteCodeTurn(options, turn(thread, { kind: "openai-compatible" }))).toMatchObject({
      status: "bound",
    });
    expect(reached).toEqual(["compose"]);
    const stranger = decodeCodeThread({
      ...thread,
      checkoutId: "71000000-0000-4000-8000-000000000009",
    });
    expect(bindRemoteCodeTurn(options, turn(stranger, { kind: "openai-compatible" }))).toEqual({
      status: "refused",
      message: "This thread's SSH target binding is not recorded on this host.",
    });
    expect(reached).toEqual(["compose"]);
  });
});
