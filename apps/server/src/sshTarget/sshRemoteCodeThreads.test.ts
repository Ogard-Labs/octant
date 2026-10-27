import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { decodeCodeThread, type CodeThread } from "@octant/contracts/code";
import { SshRemoteProject } from "@octant/contracts/ssh-remote-project";
import type { SshAdmissionDecision } from "@octant/contracts/ssh-target";
import type { NativeHarnessComposition } from "../harness/nativeHarnessComposition";
import {
  bindRemoteCodeTurn,
  remoteCodeCheckout,
  remoteCodeProjectOf,
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

/** Records which seams a binding reached, so a refusal can show it reached none. */
function seams(admission: SshAdmissionDecision = { status: "admitted" }) {
  const reached: string[] = [];
  return {
    reached,
    options: {
      store,
      connections: {
        admitProviderRuntime: () => {
          reached.push("admit-runtime");
          return admission;
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
      } satisfies Pick<NativeHarnessComposition, "forRemoteCode">,
    },
  };
}

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

  it("refuses a runtime that could be placed, since Code threads start no placed runtime yet", () => {
    const { reached, options } = seams();
    const bound = bindRemoteCodeTurn(
      options,
      turn(threadOn(remoteCodeCheckout(project)), {
        kind: "opencode",
        remotePlacement: { postures: ["approval-gated"], appToolTransport: "stdio" },
      }),
    );
    expect(bound).toMatchObject({
      status: "refused",
      message: expect.stringContaining("do not start a placed runtime yet"),
    });
    expect(reached).toEqual(["admit-runtime"]);
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
