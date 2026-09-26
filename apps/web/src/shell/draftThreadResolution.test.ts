import { decodeProjectId } from "@octant/contracts/projects";
import { describe, expect, it } from "vitest";
import {
  codeUnavailableMessage,
  resolveDraftProject,
  resolveWorkDraftChoice,
  resolveWorkProviderChoice,
} from "./draftThreadResolution";

const projectId = decodeProjectId("00000000-0000-4000-8000-000000000801");
const otherProjectId = decodeProjectId("00000000-0000-4000-8000-000000000802");

describe("resolveWorkProviderChoice", () => {
  it("falls back to an available Work provider when the saved selection is stale", () => {
    const available = {
      instanceId: "90000000-0000-4000-8000-000000000001" as never,
      modelId: "gpt-5" as never,
      label: "OpenAI Compatible — GPT-5",
    };

    expect(
      resolveWorkProviderChoice(
        [available],
        "80000000-0000-4000-8000-000000000001" as never,
        "chat-only" as never,
      ),
    ).toEqual(available);
  });
});

describe("resolveWorkProviderChoice with Work's default", () => {
  const first = {
    instanceId: "90000000-0000-4000-8000-000000000001" as never,
    modelId: "gpt-5" as never,
    label: "First",
  };
  const preferred = {
    instanceId: "90000000-0000-4000-8000-000000000002" as never,
    modelId: "sonnet" as never,
    label: "Preferred",
  };

  it("starts a new Work thread on the default from Settings when nothing was picked", () => {
    expect(
      resolveWorkProviderChoice([first, preferred], undefined, undefined, {
        defaultProviderInstanceId: preferred.instanceId,
        defaultModelId: preferred.modelId,
      }),
    ).toEqual(preferred);
  });

  it("keeps the composer's own pick over the default, and skips a default nothing serves", () => {
    expect(
      resolveWorkProviderChoice([first, preferred], first.instanceId, first.modelId, {
        defaultProviderInstanceId: preferred.instanceId,
        defaultModelId: preferred.modelId,
      }),
    ).toEqual(first);
    expect(
      resolveWorkProviderChoice([first], undefined, undefined, {
        defaultProviderInstanceId: preferred.instanceId,
        defaultModelId: preferred.modelId,
      }),
    ).toEqual(first);
  });
});

describe("resolveDraftProject", () => {
  /**
   * An explicitly chosen Project is authoritative. A draft whose Project was
   * archived or deleted while it stayed open must refuse rather than silently
   * retarget the active Project — that would start work in another repository.
   */
  it("refuses a draft whose chosen Project no longer resolves instead of substituting the active one", () => {
    const active = { id: projectId, name: "Octant" };
    const other = { id: otherProjectId, name: "Retired repo" };

    expect(
      resolveDraftProject({
        draftProjectId: other.id,
        candidates: [active],
        activeProject: active,
      }),
    ).toEqual({ kind: "unresolved-selection" });
    expect(
      resolveDraftProject({
        draftProjectId: other.id,
        candidates: [active, other],
        activeProject: active,
      }),
    ).toEqual({ kind: "project", project: other });
  });

  it("uses the active Project only for a draft that named no Project", () => {
    const active = { id: projectId, name: "Octant" };

    expect(
      resolveDraftProject({
        draftProjectId: undefined,
        candidates: [],
        activeProject: active,
      }),
    ).toEqual({ kind: "project", project: active });
    expect(
      resolveDraftProject({
        draftProjectId: undefined,
        candidates: [],
        activeProject: undefined,
      }),
    ).toEqual({ kind: "project", project: undefined });
  });
});

describe("codeUnavailableMessage", () => {
  it("says Code is loading only while it is actually loading", () => {
    expect(codeUnavailableMessage({ status: "loading" })).toMatch(/still loading/i);
    expect(codeUnavailableMessage({ status: "conflict-reload" })).toMatch(/still loading/i);
  });

  it("gives a stalled host its own reason instead of asking the user to keep waiting", () => {
    expect(
      codeUnavailableMessage({ status: "disconnected", errorMessage: "The host went away." }),
    ).toBe("The host went away.");
    expect(codeUnavailableMessage({ status: "disconnected" })).toMatch(/unavailable/i);
    expect(codeUnavailableMessage({ status: "disconnected" })).not.toMatch(/still loading/i);
    expect(codeUnavailableMessage({ status: "ready" })).not.toMatch(/still loading/i);
  });
});

describe("resolveWorkDraftChoice", () => {
  const first = {
    instanceId: "90000000-0000-4000-8000-000000000001" as never,
    modelId: "gpt-5" as never,
    label: "First",
  };
  const preferred = {
    instanceId: "90000000-0000-4000-8000-000000000002" as never,
    modelId: "sonnet" as never,
    label: "Preferred",
  };
  const defaults = {
    defaultProviderInstanceId: preferred.instanceId,
    defaultModelId: preferred.modelId,
  };
  const chatPick = { providerInstanceId: first.instanceId, modelId: first.modelId };

  it("offers no model until the host has said what Work's default is", () => {
    expect(
      resolveWorkDraftChoice({ choices: [first, preferred], settingsStatus: "loading" }),
    ).toBeUndefined();
  });

  it("keeps a model remembered from Chat or Code from overriding Work's default", () => {
    expect(
      resolveWorkDraftChoice({
        choices: [first, preferred],
        settingsStatus: "ready",
        defaults,
        sharedSelection: chatPick,
      }),
    ).toEqual(preferred);
  });

  it("lets a pick made in the Work composer win over the default", () => {
    expect(
      resolveWorkDraftChoice({
        choices: [first, preferred],
        settingsStatus: "ready",
        defaults,
        workSelection: chatPick,
      }),
    ).toEqual(first);
  });

  it("keeps the shared choice on a host without Work settings", () => {
    expect(
      resolveWorkDraftChoice({
        choices: [preferred, first],
        settingsStatus: "unsupported",
        sharedSelection: chatPick,
      }),
    ).toEqual(first);
  });
});
