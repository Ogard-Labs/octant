import {
  decodeProject,
  decodeProjectId,
  decodeProviderInstance,
  type Project,
  type ProviderInstance,
} from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { nativeSetupOption, sessionNativeSetup } from "./providerNativeSetup";

const now = "2026-10-31T10:00:00.000Z";
const projectId = decodeProjectId("70000000-0000-4000-8000-000000000101");

function codex(overrides: Record<string, unknown> = {}): ProviderInstance {
  return decodeProviderInstance({
    id: "70000000-0000-4000-8000-000000000102",
    displayName: "Codex",
    driverKind: "codex",
    configuration: { kind: "codex-cli", binaryPath: "/opt/homebrew/bin/codex" },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}

function codeProject(overrides: Record<string, unknown> = {}): Project {
  const binding = { canonicalRoot: "/Users/example/Workspace" };
  return decodeProject({
    id: projectId,
    name: "Workspace",
    lifecycle: "active",
    pinned: false,
    rank: "0/1",
    version: 1,
    createdAt: now,
    updatedAt: now,
    type: "code",
    binding,
    bindingHistory: [
      {
        revisionId: "70000000-0000-4000-8000-000000000103",
        revision: 1,
        currentBinding: binding,
        actor: { kind: "local-user", actorId: "70000000-0000-4000-8000-000000000104" },
        changedAt: now,
      },
    ],
    codeAccessPersistence: "current-session",
    ...overrides,
  });
}

function sources(instance: ProviderInstance, project: Project) {
  return {
    readProviderInstance: () => instance,
    readProject: () => project,
  };
}

describe("a session's native setup read from the journal", () => {
  it("stays off for an account and Project the person never changed", () => {
    expect(
      sessionNativeSetup(sources(codex(), codeProject()), {
        providerInstanceId: codex().id,
        projectId,
        mode: "code",
        executionPolicy: "approval-gated",
      }),
    ).toBeUndefined();
  });

  it("turns on with the account's switch, and loads the Project's code only once the Project trusts this provider", () => {
    const fromAccount = sessionNativeSetup(sources(codex({ nativeSetup: true }), codeProject()), {
      providerInstanceId: codex().id,
      projectId,
      mode: "code",
      executionPolicy: "approval-gated",
    });
    expect(fromAccount).toMatchObject({ subagents: true, projectCode: false });

    const trusted = codeProject({ nativeProviders: ["codex"] });
    expect(
      sessionNativeSetup(sources(codex(), trusted), {
        providerInstanceId: codex().id,
        projectId,
        mode: "code",
        executionPolicy: "approval-gated",
      }),
    ).toMatchObject({ subagents: true, projectCode: true });

    // Another provider's trust in the same Project does not count.
    expect(
      sessionNativeSetup(sources(codex(), codeProject({ nativeProviders: ["claude"] })), {
        providerInstanceId: codex().id,
        projectId,
        mode: "code",
        executionPolicy: "approval-gated",
      }),
    ).toBeUndefined();
  });

  it("never lets a Project's trust reach a Chat thread", () => {
    const setup = sessionNativeSetup(
      sources(codex({ nativeSetup: true }), codeProject({ nativeProviders: ["codex"] })),
      {
        providerInstanceId: codex().id,
        projectId,
        mode: "chat",
        executionPolicy: "approval-gated",
      },
    );
    expect(setup).toMatchObject({ toolServers: true, hooks: false, projectCode: false });
    expect(nativeSetupOption(undefined)).toEqual({});
    expect(nativeSetupOption(setup)).toEqual({ nativeSetup: setup });
  });
});
