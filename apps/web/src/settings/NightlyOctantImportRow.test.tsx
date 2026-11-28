// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import type {
  NightlyOctantImportOutcome,
  NightlyOctantImportPreview,
} from "@octant/contracts/app-updates";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OctantHostBridge } from "../shell/hostBridge";
import { NightlyOctantImportRow } from "./NightlyOctantImportRow";

afterEach(cleanup);

const imported: Extract<NightlyOctantImportOutcome, { kind: "imported" }> = {
  kind: "imported",
  counts: { events: 20, threads: 3, contentRows: 9, settled: 2 },
  conflicts: 1,
  heldBack: 2,
  keys: { status: "copied", copied: 4, existing: 1, failed: 1 },
  preferences: { status: "copied", copied: 6 },
};

function show(options: {
  readonly preview?: NightlyOctantImportPreview;
  readonly outcome?: NightlyOctantImportOutcome;
  readonly absent?: boolean;
}) {
  const importNightlyOctantData = vi.fn(async (_copyKeys: boolean) => options.outcome ?? imported);
  const previewNightlyOctantImport = vi.fn(
    async () => options.preview ?? { octantDataPresent: true },
  );
  const bridge = (options.absent === true
    ? {}
    : { previewNightlyOctantImport, importNightlyOctantData }) as unknown as OctantHostBridge;
  render(<NightlyOctantImportRow bridge={bridge} />);
  return { importNightlyOctantData, previewNightlyOctantImport };
}

describe("Import from Octant", () => {
  it("is hidden when Nightly offers no import or Octant has no data", async () => {
    show({ absent: true });
    expect(screen.queryByText("Import from Octant")).toBeNull();
    cleanup();
    const f = show({ preview: { octantDataPresent: false } });
    await waitFor(() => expect(f.previewNightlyOctantImport).toHaveBeenCalled());
    expect(screen.queryByText("Import from Octant")).toBeNull();
  });

  it("shows when Octant's data was last imported", async () => {
    show({ preview: { octantDataPresent: true, lastImportedAt: "2026-11-27T10:00:00.000Z" } });
    expect(await screen.findByText(/last imported /)).toBeTruthy();
    cleanup();
    show({});
    expect(await screen.findByText(/not imported yet\./)).toBeTruthy();
  });

  it("asks first, with Copy keys off, and imports nothing until confirmed", async () => {
    const f = show({});
    fireEvent.click(await screen.findByRole("button", { name: "Import from Octant" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("checkbox", { name: "Copy keys" })).not.toBeChecked();
    expect(within(dialog).getByText(/macOS may\s+ask once for each key/)).toBeTruthy();
    expect(within(dialog).getByText(/first import replaces/)).toBeTruthy();
    expect(f.importNightlyOctantData).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(f.importNightlyOctantData).not.toHaveBeenCalled();
  });

  it("sends only whether to copy keys, and summarizes what came over", async () => {
    const f = show({});
    fireEvent.click(await screen.findByRole("button", { name: "Import from Octant" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Copy keys" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Import" }));
    await waitFor(() => expect(f.importNightlyOctantData).toHaveBeenCalledWith(true));
    expect(await screen.findByText("Imported 3 threads from Octant.")).toBeTruthy();
    expect(screen.getByText(/2 items that were running in Octant arrived paused/)).toBeTruthy();
    expect(
      screen.getByText(/1 thread changed in both apps; Octant Nightly kept its own/),
    ).toBeTruthy();
    expect(screen.getByText(/2 settings or Projects changed in both apps/)).toBeTruthy();
    expect(
      screen.getByText("Keys: 4 copied, 1 already in Octant Nightly, 1 could not be copied."),
    ).toBeTruthy();
    expect(screen.getByText("Window preferences: 6 copied.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload to apply" })).toBeTruthy();
  });

  it("says in plain words why an import was refused or stopped", async () => {
    const cases: ReadonlyArray<readonly [NightlyOctantImportOutcome, RegExp]> = [
      [{ kind: "refused", reason: "octant-missing" }, /Octant's data was not found/],
      [{ kind: "refused", reason: "octant-newer" }, /newer than this Octant Nightly/],
      [{ kind: "refused", reason: "busy" }, /changing, or another import is running/],
      [{ kind: "failed", stage: "merge" }, /Nothing was changed/],
      [{ kind: "failed", stage: "start-host" }, /background service did not start again/],
    ];
    for (const [outcome, message] of cases) {
      show({ outcome });
      fireEvent.click(await screen.findByRole("button", { name: "Import from Octant" }));
      fireEvent.click(
        within(await screen.findByRole("dialog")).getByRole("button", { name: "Import" }),
      );
      expect(await screen.findByText(message)).toBeTruthy();
      cleanup();
    }
  });

  it("reports keys it could not list instead of claiming they were copied", async () => {
    show({
      outcome: { ...imported, keys: { status: "unavailable", reason: "cannot-list" } },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Import from Octant" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Import" }),
    );
    expect(
      await screen.findByText(/Keys were not copied: Octant Nightly could not list them/),
    ).toBeTruthy();
  });
});
