import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { decodeProjectId } from "@octant/contracts";
import type { WorkOverviewClient } from "@octant/client-runtime/work-overview-client";
import { useWorkOverviewController } from "./useWorkOverviewController";

const projectId = decodeProjectId("20000000-0000-4000-8000-000000000001");

describe("useWorkOverviewController", () => {
  it("loads live overview projections through the client", async () => {
    const client: WorkOverviewClient = {
      load: vi.fn().mockResolvedValue({
        projectId,
        filesAndArtifacts: [{ id: "a1", label: "Brief.docx", detail: "DOCX" }],
        workflowsAndThreads: [],
        approvals: [],
        versions: [{ id: "v1", label: "v1 · Brief.docx", detail: "Created" }],
        validation: [{ id: "docx", label: "DOCX · limited fidelity", detail: "Honest capability" }],
        exports: [],
      }),
    };

    const { result } = renderHook(() =>
      useWorkOverviewController({
        client,
        enabled: true,
        projectId,
      }),
    );

    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });
    expect(result.current.model.filesAndArtifacts.status).toBe("ready");
    expect(result.current.model.filesAndArtifacts.items?.[0]?.label).toBe("Brief.docx");
    expect(client.load).toHaveBeenCalledWith(projectId);
  });

  it("shows honest empty copy when every overview section has no items", async () => {
    const client: WorkOverviewClient = {
      load: vi.fn().mockResolvedValue({
        projectId,
        filesAndArtifacts: [],
        workflowsAndThreads: [],
        approvals: [],
        versions: [],
        validation: [],
        exports: [],
      }),
    };

    const { result } = renderHook(() =>
      useWorkOverviewController({
        client,
        enabled: true,
        projectId,
      }),
    );

    await waitFor(() => {
      expect(result.current.status).toBe("ready");
    });
    expect(result.current.model.filesAndArtifacts.status).toBe("empty");
    expect(result.current.model.filesAndArtifacts.message).toBe(
      "No recent files or artifacts in this Project yet.",
    );
    expect(result.current.model.workflowsAndThreads.status).toBe("empty");
    expect(result.current.model.approvals.status).toBe("empty");
  });
});
