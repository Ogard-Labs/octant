import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { decodeProjectId } from "@octant/contracts";
import {
  WorkOverviewClientFailure,
  type WorkOverviewClient,
} from "@octant/client-runtime/work-overview-client";
import { useWorkOverviewController } from "./useWorkOverviewController";

const projectId = decodeProjectId("20000000-0000-4000-8000-000000000001");

describe("useWorkOverviewController", () => {
  it("keeps loaded overview content visible while refreshing the same Project", async () => {
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
    vi.mocked(client.load).mockImplementation(() => new Promise<never>(() => {}));
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.status).toBe("loading"));
    expect(result.current.model.filesAndArtifacts.items?.[0]?.label).toBe("Brief.docx");
    expect(result.current.model.versions.items?.[0]?.label).toBe("v1 · Brief.docx");
  });

  it.each(["project", "client", "disabled", "unauthorized"] as const)(
    "clears loaded overview content after a %s boundary change",
    async (boundary) => {
      const client: WorkOverviewClient = {
        load: vi.fn().mockResolvedValue({
          projectId,
          filesAndArtifacts: [{ id: "a1", label: "Private brief", detail: "DOCX" }],
          workflowsAndThreads: [],
          approvals: [],
          versions: [],
          validation: [],
          exports: [],
        }),
      };
      const initialProps = { client, enabled: true, projectId };
      const { result, rerender } = renderHook(useWorkOverviewController, { initialProps });
      await waitFor(() => expect(result.current.status).toBe("ready"));
      expect(result.current.model.filesAndArtifacts.items?.[0]?.label).toBe("Private brief");
      vi.mocked(client.load).mockImplementation(() => new Promise<never>(() => {}));
      if (boundary === "unauthorized") {
        vi.mocked(client.load).mockRejectedValue(new WorkOverviewClientFailure("Denied", 401));
        act(() => result.current.retry());
        await waitFor(() => expect(result.current.status).toBe("unauthorized"));
      } else {
        rerender({
          ...initialProps,
          ...(boundary === "project"
            ? { projectId: decodeProjectId("20000000-0000-4000-8000-000000000002") }
            : {}),
          ...(boundary === "client"
            ? { client: { load: vi.fn(() => new Promise<never>(() => {})) } }
            : {}),
          ...(boundary === "disabled" ? { enabled: false } : {}),
        });
      }
      expect(result.current.model.filesAndArtifacts.items ?? []).toEqual([]);
    },
  );

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
