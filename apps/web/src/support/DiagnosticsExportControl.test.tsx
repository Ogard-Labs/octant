import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { chooseSelectFieldOption } from "../test/chooseSelectFieldOption";
import type { DiagnosticsExportClient } from "@octant/client-runtime/diagnostics-export-client";
import { decodeDiagnosticsExportOutcome } from "@octant/contracts/diagnostics";
import { DiagnosticsExportControl } from "./DiagnosticsExportControl";

function makeClient(
  exportEvidence: DiagnosticsExportClient["exportEvidence"],
): DiagnosticsExportClient {
  return { exportEvidence };
}

describe("DiagnosticsExportControl", () => {
  it("advertises only failure domains with a production support incident source", async () => {
    const user = userEvent.setup();
    render(<DiagnosticsExportControl client={makeClient(vi.fn())} />);

    const domain = screen.getByLabelText(/failure domain/i);
    expect(domain).toHaveTextContent("Provider");
    await user.click(domain);
    expect(await screen.findAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option", { name: "Provider" })).toBeInTheDocument();
  });

  it("submits the chosen domain and typed summary and shows a success receipt", async () => {
    const exportEvidence = vi.fn(async () =>
      decodeDiagnosticsExportOutcome({
        kind: "exported",
        packet: {
          packetVersion: 1,
          packetId: "00000000-0000-4000-8000-0000000000aa",
          domain: "provider",
          failureCode: "provider-support-export",
          summary: "Provider timed out.",
          hostVersions: [{ component: "runtime", version: "v22.1.0" }],
          candidateVersions: [{ component: "runtime", version: "v22.1.0" }],
          correlations: [
            {
              correlationId: "00000000-0000-4000-8000-000000000001",
              observedAt: "2026-08-10T12:00:00.000Z",
            },
          ],
          recovery: [{ action: "Verify provider credentials.", automated: false }],
          redactions: [],
          redacted: true,
          generatedAt: "2026-08-10T12:00:00.000Z",
        },
        receipt: {
          packetId: "00000000-0000-4000-8000-0000000000aa",
          domain: "provider",
          failureCode: "provider-support-export",
          redactions: [],
          contentDigest: "a".repeat(64),
          generatedAt: "2026-08-10T12:00:00.000Z",
          createdAt: "2026-08-10T12:00:01.000Z",
        },
      }),
    );
    const user = userEvent.setup();
    render(<DiagnosticsExportControl client={makeClient(exportEvidence)} />);

    await chooseSelectFieldOption(user, screen.getByLabelText(/failure domain/i), "Provider");
    fireEvent.change(screen.getByLabelText(/failure correlation id/i), {
      target: { value: "00000000-0000-4000-8000-000000000001" },
    });
    fireEvent.change(screen.getByLabelText(/describe what happened/i), {
      target: { value: "Provider timed out." },
    });
    fireEvent.click(screen.getByRole("button", { name: /export diagnostics/i }));

    await waitFor(() => {
      expect(exportEvidence).toHaveBeenCalledWith({
        correlationId: "00000000-0000-4000-8000-000000000001",
        domain: "provider",
        summary: "Provider timed out.",
      });
    });
    expect(await screen.findByText(/exported/i)).toBeInTheDocument();
    expect(screen.getByText(/00000000-0000-4000-8000-0000000000aa/)).toBeInTheDocument();
  });

  it("hands off the packet for download before showing export success", async () => {
    const exportEvidence = vi.fn(async () =>
      decodeDiagnosticsExportOutcome({
        kind: "exported",
        packet: {
          packetVersion: 1,
          packetId: "00000000-0000-4000-8000-0000000000aa",
          domain: "provider",
          failureCode: "provider-support-export",
          summary: "Provider timed out.",
          hostVersions: [{ component: "runtime", version: "v22.1.0" }],
          candidateVersions: [{ component: "runtime", version: "v22.1.0" }],
          correlations: [
            {
              correlationId: "00000000-0000-4000-8000-000000000001",
              observedAt: "2026-08-10T12:00:00.000Z",
            },
          ],
          recovery: [{ action: "Verify provider credentials.", automated: false }],
          redactions: [],
          redacted: true,
          generatedAt: "2026-08-10T12:00:00.000Z",
        },
        receipt: {
          packetId: "00000000-0000-4000-8000-0000000000aa",
          domain: "provider",
          failureCode: "provider-support-export",
          redactions: [],
          contentDigest: "a".repeat(64),
          generatedAt: "2026-08-10T12:00:00.000Z",
          createdAt: "2026-08-10T12:00:01.000Z",
        },
      }),
    );
    const createObjectURL = vi.fn(() => "blob:diagnostics");
    const originalCreateObjectURL = URL.createObjectURL;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectURL,
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    try {
      render(<DiagnosticsExportControl client={makeClient(exportEvidence)} />);
      fireEvent.change(screen.getByLabelText(/failure correlation id/i), {
        target: { value: "00000000-0000-4000-8000-000000000001" },
      });
      fireEvent.change(screen.getByLabelText(/describe what happened/i), {
        target: { value: "Provider timed out." },
      });
      fireEvent.click(screen.getByRole("button", { name: /export diagnostics/i }));

      await waitFor(() => expect(createObjectURL).toHaveBeenCalledOnce());
      expect(click).toHaveBeenCalledOnce();
      expect(await screen.findByText(/^exported$/i)).toBeInTheDocument();
    } finally {
      click.mockRestore();
      Object.defineProperty(URL, "createObjectURL", {
        configurable: true,
        value: originalCreateObjectURL,
      });
    }
  });

  it("shows the typed failure reason without claiming success", async () => {
    const exportEvidence = vi.fn(async () => ({
      kind: "failed" as const,
      failure: { category: "incomplete" as const, message: "A diagnostic summary is required." },
    }));
    render(<DiagnosticsExportControl client={makeClient(exportEvidence)} />);

    fireEvent.change(screen.getByLabelText(/describe what happened/i), {
      target: { value: "x" },
    });
    fireEvent.change(screen.getByLabelText(/failure correlation id/i), {
      target: { value: "00000000-0000-4000-8000-000000000001" },
    });
    fireEvent.click(screen.getByRole("button", { name: /export diagnostics/i }));

    expect(await screen.findByText(/A diagnostic summary is required\./)).toBeInTheDocument();
    expect(screen.queryByText(/^exported$/i)).toBeNull();
  });

  it("shows a client error without crashing when the transport rejects", async () => {
    const exportEvidence = vi.fn(async () => {
      throw new Error("Diagnostics export is unauthorized.");
    });
    render(<DiagnosticsExportControl client={makeClient(exportEvidence)} />);

    fireEvent.change(screen.getByLabelText(/describe what happened/i), {
      target: { value: "Provider timed out." },
    });
    fireEvent.change(screen.getByLabelText(/failure correlation id/i), {
      target: { value: "00000000-0000-4000-8000-000000000001" },
    });
    fireEvent.click(screen.getByRole("button", { name: /export diagnostics/i }));

    expect(await screen.findByText(/Diagnostics export is unauthorized\./)).toBeInTheDocument();
  });

  it("disables the export button while the summary is empty", () => {
    render(<DiagnosticsExportControl client={makeClient(vi.fn())} />);
    expect(screen.getByRole("button", { name: /export diagnostics/i })).toBeDisabled();
  });
});
