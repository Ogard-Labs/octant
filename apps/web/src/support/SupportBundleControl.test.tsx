import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiagnosticsExportClient } from "@octant/client-runtime/diagnostics-export-client";
import {
  decodeSupportBundleOutcome,
  decodeSupportBundlePreview,
} from "@octant/contracts/support-bundle";
import { SupportBundleControl } from "./SupportBundleControl";

const preview = decodeSupportBundlePreview({
  bundleVersion: 1,
  generatedAt: "2026-10-31T10:00:00.000Z",
  sections: [
    {
      id: "providers",
      title: "Providers",
      includes: "Each enabled provider by kind.",
      entries: 2,
      available: true,
    },
    {
      id: "host-log",
      title: "Host log",
      includes: "The most recent host log lines.",
      entries: 0,
      available: false,
    },
  ],
  neverIncluded: ["Messages, prompts, replies, or notes.", "API keys, tokens, or passwords."],
});

const exported = decodeSupportBundleOutcome({
  kind: "exported",
  files: [{ path: "readme.txt", contents: "Octant support bundle" }],
  receipt: {
    bundleId: "00000000-0000-4000-8000-000000000001",
    exportedAt: "2026-10-31T10:00:00.000Z",
    destinationCategory: "browser-download",
    sections: ["providers"],
    fileCount: 1,
    byteCount: 21,
  },
});

function clientWith(overrides: Partial<DiagnosticsExportClient>): DiagnosticsExportClient {
  return {
    exportEvidence: vi.fn(),
    readJournalGrowth: vi.fn(),
    readSupportBundlePreview: vi.fn(async () => preview),
    exportSupportBundle: vi.fn(async () => exported),
    ...overrides,
  };
}

let clicked: Array<{ download: string }> = [];
beforeEach(() => {
  clicked = [];
  URL.createObjectURL = vi.fn(() => "blob:octant");
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
    function (this: HTMLAnchorElement) {
      clicked.push({ download: this.download });
    },
  );
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("SupportBundleControl", () => {
  it("lists what the file holds and never holds before anything is saved", async () => {
    const client = clientWith({});
    render(<SupportBundleControl client={client} />);
    fireEvent.click(screen.getByRole("button", { name: "Save diagnostics…" }));

    expect(await screen.findByText("This file will include")).toBeInTheDocument();
    expect(screen.getByText("Providers")).toBeInTheDocument();
    expect(screen.getByText("2 entries")).toBeInTheDocument();
    expect(screen.getByText("Not available")).toBeInTheDocument();
    expect(screen.getByText("Messages, prompts, replies, or notes.")).toBeInTheDocument();
    expect(client.exportSupportBundle).not.toHaveBeenCalled();
    expect(clicked).toEqual([]);
  });

  it("saves a zip only after Save file and tells the host it went to a browser download", async () => {
    const client = clientWith({});
    render(<SupportBundleControl client={client} />);
    fireEvent.click(screen.getByRole("button", { name: "Save diagnostics…" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save file" }));

    await waitFor(() => expect(clicked).toHaveLength(1));
    expect(clicked[0]?.download).toBe("octant-diagnostics-20261031-100000.zip");
    expect(client.exportSupportBundle).toHaveBeenCalledWith({
      destinationCategory: "browser-download",
    });
    expect(await screen.findByText(/Nothing was sent/)).toBeInTheDocument();
  });

  it("saves nothing when cancelled", async () => {
    const client = clientWith({});
    render(<SupportBundleControl client={client} />);
    fireEvent.click(screen.getByRole("button", { name: "Save diagnostics…" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(screen.queryByText("This file will include")).not.toBeInTheDocument();
    expect(client.exportSupportBundle).not.toHaveBeenCalled();
  });

  it("says nothing was saved when the host refuses to build the bundle", async () => {
    const client = clientWith({
      exportSupportBundle: vi.fn(async () => ({
        kind: "failed" as const,
        message: "The support bundle could not be recorded, so nothing was saved.",
      })),
    });
    render(<SupportBundleControl client={client} />);
    fireEvent.click(screen.getByRole("button", { name: "Save diagnostics…" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save file" }));

    expect(await screen.findByText(/could not be recorded/)).toBeInTheDocument();
    expect(clicked).toEqual([]);
  });

  it("reports a list the host could not read", async () => {
    const client = clientWith({
      readSupportBundlePreview: vi.fn(async () => {
        throw new Error("down");
      }),
    });
    render(<SupportBundleControl client={client} />);
    fireEvent.click(screen.getByRole("button", { name: "Save diagnostics…" }));

    expect(await screen.findByText(/could not list what a bundle holds/)).toBeInTheDocument();
  });

  describe("in the desktop app", () => {
    it("opens the native save dialog instead of downloading and asks the host for nothing itself", async () => {
      const client = clientWith({});
      const saveNatively = vi.fn(async () => ({
        kind: "saved" as const,
        fileName: "for-support.zip",
      }));
      render(<SupportBundleControl client={client} saveNatively={saveNatively} />);
      fireEvent.click(screen.getByRole("button", { name: "Save diagnostics…" }));
      expect(saveNatively).not.toHaveBeenCalled();
      fireEvent.click(await screen.findByRole("button", { name: "Save file" }));

      expect(await screen.findByText(/Saved for-support\.zip/)).toBeInTheDocument();
      expect(saveNatively).toHaveBeenCalledOnce();
      expect(client.exportSupportBundle).not.toHaveBeenCalled();
      expect(clicked).toEqual([]);
    });

    it("returns to the list when the person dismisses the dialog", async () => {
      const client = clientWith({});
      const saveNatively = vi.fn(async () => ({ kind: "cancelled" as const }));
      render(<SupportBundleControl client={client} saveNatively={saveNatively} />);
      fireEvent.click(screen.getByRole("button", { name: "Save diagnostics…" }));
      fireEvent.click(await screen.findByRole("button", { name: "Save file" }));

      await waitFor(() => expect(screen.getByRole("button", { name: "Save file" })).toBeEnabled());
      expect(screen.getByText("This file will include")).toBeInTheDocument();
      expect(screen.queryByText(/Saved /)).not.toBeInTheDocument();
    });

    it("says nothing was written when the host could not write the file", async () => {
      const client = clientWith({});
      const saveNatively = vi.fn(async () => {
        throw new Error("Octant could not save the diagnostics. Nothing was written.");
      });
      render(<SupportBundleControl client={client} saveNatively={saveNatively} />);
      fireEvent.click(screen.getByRole("button", { name: "Save diagnostics…" }));
      fireEvent.click(await screen.findByRole("button", { name: "Save file" }));

      expect(await screen.findByText(/Nothing was written/)).toBeInTheDocument();
      expect(client.exportSupportBundle).not.toHaveBeenCalled();
    });
  });
});
