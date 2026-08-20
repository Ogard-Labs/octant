import { decodeProjectId } from "@octant/contracts/projects";
import { describe, expect, it } from "vitest";
import { resolveDraftProject, resolveWorkProviderChoice } from "./draftThreadResolution";

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
