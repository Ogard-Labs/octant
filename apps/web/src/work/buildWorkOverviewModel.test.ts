import type { ProjectAvailability } from "@octant/contracts/projects";
import { describe, expect, it } from "vitest";
import { buildWorkOverviewModel } from "./buildWorkOverviewModel";

describe("buildWorkOverviewModel", () => {
  it("composes ready sections from projection items without inventing metrics", () => {
    const model = buildWorkOverviewModel({
      filesAndArtifacts: [{ id: "a1", label: "Brief.docx", detail: "DOCX" }],
      workflowsAndThreads: [{ id: "t1", label: "Brief thread", detail: "Active" }],
    });

    expect(model.filesAndArtifacts).toEqual({
      status: "ready",
      items: [{ id: "a1", label: "Brief.docx", detail: "DOCX" }],
    });
    expect(model.workflowsAndThreads.status).toBe("ready");
    expect(model.approvals.status).toBe("empty");
    expect(model.versions.status).toBe("empty");
    expect(model.validation.status).toBe("empty");
    expect(model.exports.status).toBe("empty");
  });

  it("marks confined sections unavailable when the Project root is unavailable", () => {
    const availability = {
      status: "unavailable",
      reason: "Bound root moved.",
    } as ProjectAvailability;
    const model = buildWorkOverviewModel({
      availability,
      filesAndArtifacts: [{ id: "a1", label: "stale" }],
    });

    expect(model.filesAndArtifacts.status).toBe("unavailable");
    expect(model.filesAndArtifacts.message).toBe("Bound root moved.");
    expect(model.workflowsAndThreads.status).toBe("unavailable");
  });

  it("preserves explicit per-section failure without blanking sibling sections", () => {
    const model = buildWorkOverviewModel({
      filesAndArtifacts: [{ id: "a1", label: "Brief.docx" }],
      sectionStatus: { approvals: "failure" },
      sectionMessage: { approvals: "Approvals could not be loaded." },
    });

    expect(model.filesAndArtifacts.status).toBe("ready");
    expect(model.approvals).toEqual({
      status: "failure",
      message: "Approvals could not be loaded.",
      items: [],
    });
  });
});
