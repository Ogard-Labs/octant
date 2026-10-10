import type { ArtifactSyncedDetail } from "@octant/contracts/artifact-library";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SyncedArtifactDialog } from "./SyncedArtifactDialog";

const svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
const studio = "30000000-0000-4000-8000-00000000002a";
const laptop = "30000000-0000-4000-8000-00000000002b";

const twoVersions = {
  kind: "artifact-synced-detail",
  canvasId: "10000000-0000-4000-8000-000000000001",
  title: "Launch plan",
  projectName: "Launch",
  mode: "work",
  status: "two-versions",
  openHere: false,
  versions: [
    {
      versionId: studio,
      title: "Launch plan",
      computerName: "Studio Mac",
      thisComputer: false,
      createdAt: "2026-08-18T08:30:00.000Z",
      candidate: true,
      preview: { format: "svg", markup: svg },
    },
    {
      versionId: laptop,
      title: "Launch plan (beta)",
      computerName: "MacBook Air",
      thisComputer: true,
      createdAt: "2026-08-18T08:00:00.000Z",
      candidate: true,
      preview: { format: "svg", markup: svg },
    },
    {
      versionId: "30000000-0000-4000-8000-000000000001",
      title: "Launch plan",
      computerName: "Studio Mac",
      thisComputer: false,
      createdAt: "2026-08-17T09:00:00.000Z",
      candidate: false,
    },
  ],
  threads: [
    {
      threadId: "40000000-0000-4000-8000-000000000001",
      mode: "work",
      projectId: "50000000-0000-4000-8000-000000000001",
      projectName: "Field notes",
      title: "Launch review",
    },
  ],
} as unknown as ArtifactSyncedDetail;

function dialog(detail: ArtifactSyncedDetail, overrides: Record<string, unknown> = {}) {
  const handlers = {
    onKeep: vi.fn(),
    onMerge: vi.fn(),
    onRestore: vi.fn(),
    onOpenIn: vi.fn(),
    onCreate: vi.fn(),
    onClose: vi.fn(),
  };
  render(
    <SyncedArtifactDialog
      busy={false}
      detail={detail}
      observedAt="2026-08-18T09:00:00.000Z"
      open
      {...handlers}
      {...overrides}
    />,
  );
  return handlers;
}

describe("choosing between two versions", () => {
  it("shows both versions side by side, each with who wrote it, and keeps the one chosen", async () => {
    const { onKeep } = dialog(twoVersions);
    const choices = within(screen.getByRole("region", { name: "Two versions" })).getAllByRole(
      "listitem",
    );
    expect(choices).toHaveLength(2);
    expect(within(choices[0] as HTMLElement).getByText(/Written on Studio Mac/)).toBeTruthy();
    expect(
      within(choices[1] as HTMLElement).getByText(/Written on MacBook Air \(this computer\)/),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Keep the version from Studio Mac" }));
    expect(onKeep).toHaveBeenCalledWith(studio);
  });

  it("merges into the chosen thread when the artifact is not open here", async () => {
    const { onMerge } = dialog(twoVersions);
    await userEvent.click(screen.getByRole("button", { name: "Merge" }));
    expect(onMerge).toHaveBeenCalledWith("40000000-0000-4000-8000-000000000001");
  });

  it("merges without asking for a thread once it is open here", async () => {
    const { onMerge } = dialog({ ...twoVersions, openHere: true, threads: [] });
    expect(screen.queryByLabelText("Thread")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Merge" }));
    expect(onMerge).toHaveBeenCalledWith(undefined);
  });

  it("lists every version with the computer that wrote it", () => {
    dialog(twoVersions);
    const versions = within(screen.getByRole("region", { name: "Versions" })).getAllByRole(
      "listitem",
    );
    expect(versions.map((item) => item.textContent)).toEqual([
      expect.stringContaining("Written on Studio Mac"),
      expect.stringContaining("Written on MacBook Air (this computer)"),
      expect.stringContaining("Written on Studio Mac"),
    ]);
  });
});

describe("a synced artifact's other states", () => {
  it("offers Restore for one deleted on another computer, and nothing to open", async () => {
    const { onRestore } = dialog({
      ...twoVersions,
      status: "deleted",
      deletedOn: "Studio Mac",
      versions: twoVersions.versions.map((version) => ({ ...version, candidate: false })),
    } as ArtifactSyncedDetail);
    expect(screen.getByRole("heading", { name: "Deleted on Studio Mac" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Keep the version/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(onRestore).toHaveBeenCalledOnce();
  });

  it("opens a current one in the thread chosen", async () => {
    const { onOpenIn } = dialog({ ...twoVersions, status: "current" } as ArtifactSyncedDetail);
    expect(screen.queryByRole("region", { name: "Two versions" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(onOpenIn).toHaveBeenCalledWith("40000000-0000-4000-8000-000000000001");
  });

  it("says when no thread here can take it, and offers the choices there are", async () => {
    const { onCreate, onClose, onOpenIn } = dialog({
      ...twoVersions,
      mode: "chat",
      status: "current",
      threads: [],
    } as ArtifactSyncedDetail);
    expect(screen.getByText(/No thread on this computer can take it/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Start a thread" }));
    expect(onCreate).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "Keep it in the library" }));
    expect(onClose).toHaveBeenCalled();
    expect(onOpenIn).not.toHaveBeenCalled();
  });

  it("states the host's refusal in its own words", () => {
    dialog(twoVersions, { message: "Turn sync on to send this choice to your other computers." });
    expect(screen.getByRole("status").textContent).toBe(
      "Turn sync on to send this choice to your other computers.",
    );
  });
});

describe("when no thread here can take a Work artifact", () => {
  it("names the mode to start a thread in, without offering the library's Chat thread", () => {
    dialog({ ...twoVersions, status: "current", threads: [] } as ArtifactSyncedDetail);
    expect(screen.getByText(/Start a Work thread, then open it here/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start a thread" })).toBeNull();
    expect(screen.getByRole("button", { name: "Keep it in the library" })).toBeTruthy();
  });
});
