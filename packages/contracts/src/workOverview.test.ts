import { describe, expect, it } from "vitest";
import { decodeWorkOverviewProjection, decodeProjectId } from "./index";

describe("WorkOverviewProjection", () => {
  it("decodes a sanitized overview projection without host paths", () => {
    const projectId = decodeProjectId("20000000-0000-4000-8000-000000000001");
    const decoded = decodeWorkOverviewProjection({
      projectId,
      filesAndArtifacts: [{ id: "a1", label: "Brief.docx", detail: "DOCX" }],
      workflowsAndThreads: [],
      approvals: [],
      versions: [{ id: "v1", label: "v2 · Brief.docx", detail: "Revised" }],
      validation: [{ id: "doc", label: "DOCX · limited fidelity", detail: "Honest capability" }],
      exports: [],
    });
    expect(decoded.filesAndArtifacts[0]?.label).toBe("Brief.docx");
    expect(JSON.stringify(decoded)).not.toMatch(/[/\\]|file:/i);
  });

  it("rejects oversized item labels", () => {
    expect(() =>
      decodeWorkOverviewProjection({
        projectId: "20000000-0000-4000-8000-000000000001",
        filesAndArtifacts: [{ id: "a1", label: "x".repeat(513) }],
        workflowsAndThreads: [],
        approvals: [],
        versions: [],
        validation: [],
        exports: [],
      }),
    ).toThrow();
  });
});
