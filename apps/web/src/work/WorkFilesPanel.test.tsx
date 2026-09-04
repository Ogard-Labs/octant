import { decodeProjectId, decodeWorkThreadId } from "@octant/contracts";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { WorkFilesPanel } from "./WorkFilesPanel";

const projectId = decodeProjectId("00000000-0000-4000-8000-0000000009b1");
const threadId = decodeWorkThreadId("00000000-0000-4000-8000-0000000007b1");

function listing(
  entries: ReadonlyArray<Record<string, unknown>>,
  truncated = false,
): Record<string, unknown> {
  return {
    status: "listed",
    listing: {
      kind: "work-file-listing",
      threadId,
      projectId,
      entries,
      truncated,
      observedAt: "2026-09-04T10:00:00.000Z",
    },
  };
}

function client(result: unknown) {
  return { list: vi.fn(async () => result) } as never;
}

describe("WorkFilesPanel", () => {
  it("names what the work produced above the rest of the folder", async () => {
    render(
      <WorkFilesPanel
        client={client(
          listing([
            {
              kind: "file",
              path: "summary.docx",
              byteLength: 2048,
              origin: "authored",
              artifact: {
                artifactId: "00000000-0000-4000-8000-0000000005b1",
                format: "docx",
                sequence: 3,
              },
            },
            { kind: "file", path: "notes.txt", byteLength: 12, origin: "untouched" },
            { kind: "directory", path: "research" },
          ]),
        )}
        projectId={projectId}
        threadId={threadId}
      />,
    );

    const made = await screen.findByRole("region", { name: "Made here" });
    expect(within(made).getByText("summary.docx")).toBeVisible();
    // Format and version come from the host's artifact record, never a guess
    // at the extension.
    expect(within(made).getByText("Word · v3 · 2 KB")).toBeVisible();

    const folder = screen.getByRole("region", { name: "In this folder" });
    expect(within(folder).getByText("notes.txt")).toBeVisible();
    expect(within(folder).getByText("research")).toBeVisible();
    expect(within(folder).getByText("Folder")).toBeVisible();
  });

  it("opens a listed file through the target the host minted for it", async () => {
    const onOpenFile = vi.fn();
    const user = userEvent.setup();
    render(
      <WorkFilesPanel
        client={client({
          status: "listed",
          listing: {
            kind: "work-file-listing",
            threadId,
            projectId,
            entries: [
              {
                kind: "file",
                path: "summary.md",
                byteLength: 10,
                origin: "authored",
                preview: {
                  targetId: "00000000-0000-4000-8000-0000000004a1",
                  opaqueRef: "00000000-0000-4000-8000-0000000004a2",
                },
              },
            ],
            previewHostId: "00000000-0000-4000-8000-0000000004a3",
            truncated: false,
            observedAt: "2026-09-04T10:00:00.000Z",
          },
        })}
        onOpenFile={onOpenFile}
        projectId={projectId}
        threadId={threadId}
      />,
    );

    await user.click(await screen.findByRole("button", { name: /summary\.md/ }));

    // Every value comes from the host: the renderer never assembles a target of
    // its own, and never names a path.
    expect(onOpenFile).toHaveBeenCalledWith({
      targetId: "00000000-0000-4000-8000-0000000004a1",
      opaqueRef: "00000000-0000-4000-8000-0000000004a2",
      hostId: "00000000-0000-4000-8000-0000000004a3",
      projectId,
      displayName: "summary.md",
    });
  });

  it("leaves a file the host gave no target inert rather than looking clickable", async () => {
    const onOpenFile = vi.fn();
    render(
      <WorkFilesPanel
        client={client(
          listing([{ kind: "file", path: "notes.txt", byteLength: 4, origin: "untouched" }]),
        )}
        onOpenFile={onOpenFile}
        projectId={projectId}
        threadId={threadId}
      />,
    );

    expect(await screen.findByText("notes.txt")).toBeVisible();
    expect(screen.queryByRole("button", { name: /notes\.txt/ })).not.toBeInTheDocument();
  });

  it("states no format for a file the folder already held", async () => {
    render(
      <WorkFilesPanel
        client={client(
          listing([{ kind: "file", path: "brief.pdf", byteLength: 900, origin: "untouched" }]),
        )}
        projectId={projectId}
        threadId={threadId}
      />,
    );

    const folder = await screen.findByRole("region", { name: "In this folder" });
    expect(within(folder).getByText("900 B")).toBeVisible();
    expect(screen.queryByText(/PDF/)).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Made here" })).not.toBeInTheDocument();
  });

  it("says the list is incomplete when the host truncated the walk", async () => {
    render(
      <WorkFilesPanel
        client={client(
          listing([{ kind: "file", path: "a.txt", byteLength: 1, origin: "untouched" }], true),
        )}
        projectId={projectId}
        threadId={threadId}
      />,
    );

    expect(
      await screen.findByText("Octant listed part of this folder. The list is incomplete."),
    ).toBeVisible();
  });

  it("surfaces the host's own refusal rather than an empty folder", async () => {
    render(
      <WorkFilesPanel
        client={client({
          status: "failed",
          failure: {
            category: "not-found",
            message: "That folder is not inside this Project's folder.",
          },
        })}
        projectId={projectId}
        threadId={threadId}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That folder is not inside this Project's folder.",
    );
  });

  it("reports unavailable rather than listing when the thread has no Project", async () => {
    const listClient = client(listing([]));
    render(<WorkFilesPanel client={listClient} threadId={threadId} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Work files are unavailable in this window.",
    );
  });
});
