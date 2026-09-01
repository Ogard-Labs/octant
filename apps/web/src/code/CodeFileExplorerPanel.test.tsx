import type { CodeCheckoutId, CodeFileListingResult, CodeThreadId } from "@octant/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CodeFileExplorerPanel } from "./CodeFileExplorerPanel";

const threadId = "00000000-0000-4000-8000-000000000901" as CodeThreadId;
const checkoutId = "00000000-0000-4000-8000-000000000902" as CodeCheckoutId;
const fileId = "00000000-0000-4000-8000-000000000903";

function listing(entries: ReadonlyArray<unknown>, truncated = false): CodeFileListingResult {
  return {
    status: "listed",
    listing: {
      kind: "code-file-listing",
      threadId,
      checkoutId,
      entries,
      truncated,
      observedAt: "2026-08-14T08:00:00.000Z",
    },
  } as unknown as CodeFileListingResult;
}

function client(result: CodeFileListingResult | (() => Promise<never>)) {
  return {
    list: vi.fn(typeof result === "function" ? result : async () => result),
    // A host that reports nothing is the quiet case every other test wants.
    watch: vi.fn(async function* () {}),
  } as never;
}

/**
 * A client whose watch hands out the given notices one at a time, so a test
 * drives the explorer exactly as the host would when the agent edits a file.
 */
function watchingClient(notices: ReadonlyArray<unknown>) {
  const listings: CodeFileListingResult[] = [
    listing([
      {
        kind: "file",
        fileId,
        path: "src/main.ts",
        byteLength: 12,
        availability: { status: "available" },
      },
    ]),
    listing([
      {
        kind: "file",
        fileId,
        path: "src/main.ts",
        byteLength: 12,
        availability: { status: "available" },
      },
      {
        kind: "file",
        fileId,
        path: "src/added.ts",
        byteLength: 4,
        availability: { status: "available" },
      },
    ]),
  ];
  let call = 0;
  return {
    list: vi.fn(async () => listings[Math.min(call++, listings.length - 1)]!),
    watch: vi.fn(async function* () {
      for (const notice of notices) yield notice;
      // Staying open is what the host does; ending here would only make the
      // hook reconnect on a timer the test does not need.
      await new Promise(() => undefined);
    }),
  } as never;
}

describe("CodeFileExplorerPanel", () => {
  it("relists the repository when the host reports that files changed", async () => {
    render(
      <CodeFileExplorerPanel
        checkoutId={checkoutId}
        client={watchingClient([
          {
            kind: "code-file-change",
            threadId,
            checkoutId,
            paths: ["src/added.ts"],
            truncated: false,
            observedAt: "2026-08-14T08:00:01.000Z",
          },
        ])}
        onOpenFile={vi.fn()}
        threadId={threadId}
      />,
    );

    expect(await screen.findByRole("treeitem", { name: /src\/added\.ts/ })).toBeVisible();
  });

  it("relists the repository when the host cannot name every changed path", async () => {
    render(
      <CodeFileExplorerPanel
        checkoutId={checkoutId}
        client={watchingClient([
          {
            kind: "code-file-change",
            threadId,
            checkoutId,
            paths: [],
            truncated: true,
            observedAt: "2026-08-14T08:00:01.000Z",
          },
        ])}
        onOpenFile={vi.fn()}
        threadId={threadId}
      />,
    );

    expect(await screen.findByRole("treeitem", { name: /src\/added\.ts/ })).toBeVisible();
  });

  it("renders the host's listing as a repository tree", async () => {
    render(
      <CodeFileExplorerPanel
        checkoutId={checkoutId}
        client={client(
          listing([
            { kind: "directory", path: "src" },
            {
              kind: "file",
              fileId,
              path: "src/main.ts",
              byteLength: 12,
              availability: { status: "available" },
            },
          ]),
        )}
        onOpenFile={vi.fn()}
        threadId={threadId}
      />,
    );

    const sourceDirectory = await screen.findByRole("treeitem", { name: "src" });
    expect(sourceDirectory).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(sourceDirectory);

    expect(screen.getByRole("treeitem", { name: /src\/main\.ts/ })).toBeVisible();
    expect(sourceDirectory).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps the host's read-only classification instead of re-deriving it", async () => {
    render(
      <CodeFileExplorerPanel
        checkoutId={checkoutId}
        client={client(
          listing([
            {
              kind: "file",
              fileId,
              path: "logs/large.log",
              byteLength: 9_000_000,
              availability: { status: "read-only", reason: "oversized" },
            },
          ]),
        )}
        onOpenFile={vi.fn()}
        threadId={threadId}
      />,
    );

    expect(await screen.findByRole("treeitem", { name: /Oversized · read-only/ })).toBeVisible();
  });

  it("opens a file through the caller's handler", async () => {
    const onOpenFile = vi.fn();
    render(
      <CodeFileExplorerPanel
        checkoutId={checkoutId}
        client={client(
          listing([
            {
              kind: "file",
              fileId,
              path: "src/main.ts",
              byteLength: 12,
              availability: { status: "available" },
            },
          ]),
        )}
        onOpenFile={onOpenFile}
        threadId={threadId}
      />,
    );

    (await screen.findByRole("treeitem", { name: /src\/main\.ts/ })).click();
    await waitFor(() => expect(onOpenFile).toHaveBeenCalledTimes(1));
    expect(onOpenFile.mock.calls[0]?.[0]).toMatchObject({ path: "src/main.ts" });
  });

  it("says the tree is incomplete when the host truncated the walk", async () => {
    render(
      <CodeFileExplorerPanel
        checkoutId={checkoutId}
        client={client(
          listing(
            [
              {
                kind: "file",
                fileId,
                path: "a.ts",
                byteLength: 1,
                availability: { status: "available" },
              },
            ],
            true,
          ),
        )}
        onOpenFile={vi.fn()}
        threadId={threadId}
      />,
    );

    expect(
      await screen.findByText(
        "Octant listed part of this repository. The file tree is incomplete.",
      ),
    ).toBeVisible();
  });

  it("states the host's failure rather than an empty repository", async () => {
    render(
      <CodeFileExplorerPanel
        checkoutId={checkoutId}
        client={client({
          status: "failed",
          failure: { category: "unavailable", message: "Code file listing is unavailable." },
        } as unknown as CodeFileListingResult)}
        onOpenFile={vi.fn()}
        threadId={threadId}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("Code file listing is unavailable.");
  });

  it("explains an unbound thread instead of showing an empty tree", () => {
    render(<CodeFileExplorerPanel onOpenFile={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "This Code thread is not bound to a checkout",
    );
  });
});
