import { THREAD_EXPORT_FORMAT, type ThreadExportOutcome } from "@octant/contracts/thread-export";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ThreadExportControl } from "./ThreadExportControl";

const threadId = "00000000-0000-4000-8000-000000000901";

function exported(): ThreadExportOutcome {
  return {
    kind: "exported",
    bundle: {
      octant: {
        format: THREAD_EXPORT_FORMAT,
        threadId,
        mode: "chat",
        title: "Launch plan",
        hostId: "local" as never,
        version: 1,
        sequence: 1,
        generatedAt: "2026-08-19T12:00:00.000Z" as never,
      },
      transcript: { entries: [], activeCount: 0, revisedCount: 0 },
      evidence: { artifacts: [], attachments: [], citations: [] },
      provenance: {
        mode: "chat",
        threadId,
        hostId: "local" as never,
        providerInstanceId: "10000000-0000-4000-8000-000000000001" as never,
        modelId: "model-a" as never,
        createdAt: "2026-08-19T12:00:00.000Z" as never,
        updatedAt: "2026-08-19T12:00:00.000Z" as never,
      },
      omissions: [],
    },
  };
}

describe("ThreadExportControl", () => {
  it("asks the host for the cut and downloads it", async () => {
    const exportThread = vi.fn(async () => exported());
    const createObjectURL = vi.fn(() => "blob:thread-export");
    const originalCreateObjectURL = URL.createObjectURL;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectURL,
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    try {
      render(
        <ThreadExportControl
          client={{ exportThread }}
          mode="chat"
          threadId={threadId}
          title="Launch plan"
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Export thread" }));
      await waitFor(() => expect(exportThread).toHaveBeenCalledWith({ mode: "chat", threadId }));
      expect(await screen.findByText(/Saved launch-plan\.octant-thread\.json/)).toBeInTheDocument();
      expect(click).toHaveBeenCalled();
    } finally {
      click.mockRestore();
      Object.defineProperty(URL, "createObjectURL", {
        configurable: true,
        value: originalCreateObjectURL,
      });
    }
  });

  it("says so when the host refuses", async () => {
    const exportThread = vi.fn(async () => ({
      kind: "refused" as const,
      reason: "not-found" as const,
    }));
    render(
      <ThreadExportControl
        client={{ exportThread }}
        mode="work"
        threadId={threadId}
        title="Brief"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Export thread" }));
    expect(await screen.findByText("This thread could not be exported.")).toBeInTheDocument();
  });
});
