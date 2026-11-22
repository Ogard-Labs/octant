import { describe, expect, it, vi } from "vitest";
import type {
  ProjectProviderPolicy,
  ProviderCatalogSnapshot,
  ProviderInstance,
} from "@octant/contracts";
import { createCodeDelegationServices } from "./codeDelegationServices";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

function instance(id: string, enabled = true): ProviderInstance {
  return { id, enabled, displayName: id } as never;
}

function catalog(
  instanceId: string,
  models: ReadonlyArray<{ readonly id: string; readonly dataTags?: ReadonlyArray<"eu" | "zdr"> }>,
): ProviderCatalogSnapshot {
  return {
    instanceId,
    models: models.map((model, index) => ({ ...model, orderHint: index })),
    manualModelOrder: [],
  } as never;
}

function services(input: {
  readonly policy?: ProjectProviderPolicy;
  readonly instances: ReadonlyArray<ProviderInstance>;
  readonly catalogs: ReadonlyArray<ProviderCatalogSnapshot>;
  readonly code?: Parameters<typeof createCodeDelegationServices>[0]["code"];
  readonly remoteUrl?: string;
}) {
  const project = {
    id: PROJECT_ID,
    type: "code",
    lifecycle: "active",
    binding: { canonicalRoot: "/repo" },
    ...(input.policy === undefined ? {} : { providerPolicy: input.policy }),
  } as never;
  return createCodeDelegationServices({
    scope: "host" as never,
    readProject: () => project,
    readProviderInstances: () => input.instances,
    readProviderDefaults: () => ({}) as never,
    readProviderCatalogs: () => input.catalogs,
    remoteUrl: async () => input.remoteUrl,
    code: input.code ?? ({} as never),
  });
}

describe("the provider a delegated Code thread starts on", () => {
  it("skips a turned-off provider and takes the first model the Project's EU/ZDR policy allows", () => {
    const chosen = services({
      policy: { mode: "eu-zdr", providerInstanceIds: [] },
      instances: [instance("off", false), instance("on")],
      catalogs: [
        catalog("off", [{ id: "off-model", dataTags: ["eu"] }]),
        catalog("on", [{ id: "untagged" }, { id: "tagged", dataTags: ["eu"] }]),
      ],
    }).defaultProvider(PROJECT_ID as never);
    expect(chosen).toEqual({ providerInstanceId: "on", modelId: "tagged" });
  });
});

describe("the repository a delegated pull request is based on", () => {
  it("reads owner/repository from scp, ssh:// and https GitHub remotes and nothing from another host", async () => {
    const repositoryOf = (remoteUrl: string) =>
      services({ instances: [], catalogs: [], remoteUrl }).deliveryRepository(
        PROJECT_ID as never,
        "origin",
      );
    expect(await repositoryOf("git@github.com:acme/widget.git")).toBe("acme/widget");
    expect(await repositoryOf("ssh://git@github.com/acme/widget.git")).toBe("acme/widget");
    expect(await repositoryOf("https://github.com/acme/widget")).toBe("acme/widget");
    expect(await repositoryOf("https://gitlab.example/acme/widget.git")).toBeUndefined();
  });
});

describe("starting a delegated Code turn", () => {
  it("never starts the provider turn when the grant ended while the prompt was staged", async () => {
    let granted = true;
    const executeOperation = vi.fn(async () => ({ kind: "provider-turn-state", state: "running" }));
    const started = await services({
      instances: [],
      catalogs: [],
      code: {
        stageEvidence: async (_scope: unknown, _thread: unknown, prompt: string) => {
          granted = false;
          return prompt;
        },
        executeOperation,
      } as never,
    }).startTurn({
      threadId: "33333333-3333-4333-8333-333333333333",
      checkoutId: "44444444-4444-4444-8444-444444444444",
      operationId: "55555555-5555-4555-8555-555555555555",
      sessionId: "66666666-6666-4666-8666-666666666666",
      prompt: "Fix the flaky test",
      admissionCurrent: () => granted,
    });
    expect(started).toBe("refused");
    expect(executeOperation).not.toHaveBeenCalled();
  });

  it("lets the provider start check the grant again while the turn prepares its checkpoint", async () => {
    let granted = true;
    let checkedAtStart: boolean | undefined;
    const executeOperation = vi.fn(
      async (
        _scope: unknown,
        _command: unknown,
        options?: { readonly admissionCurrent?: () => boolean },
      ) => {
        // The person turns delegated work off while the checkpoint is taken.
        granted = false;
        checkedAtStart = options?.admissionCurrent?.();
        return { kind: "provider-turn-state", state: "running" };
      },
    );
    await services({
      instances: [],
      catalogs: [],
      code: {
        stageEvidence: async (_scope: unknown, _thread: unknown, prompt: string) => prompt,
        executeOperation,
      } as never,
    }).startTurn({
      threadId: "33333333-3333-4333-8333-333333333333",
      checkoutId: "44444444-4444-4444-8444-444444444444",
      operationId: "55555555-5555-4555-8555-555555555555",
      sessionId: "66666666-6666-4666-8666-666666666666",
      prompt: "Fix the flaky test",
      admissionCurrent: () => granted,
    });
    expect(checkedAtStart).toBe(false);
  });
});
