import type { CodeCheckoutId, CodeSearchResult, CodeThreadId } from "@octant/contracts";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CodeSearchDialog } from "./CodeSearchDialog";

const threadId = "00000000-0000-4000-8000-000000000901" as CodeThreadId;
const checkoutId = "00000000-0000-4000-8000-000000000902" as CodeCheckoutId;
const fileId = "00000000-0000-4000-8000-000000000903";

function searched(matches: ReadonlyArray<unknown>, truncated = false): CodeSearchResult {
  return {
    status: "searched",
    search: {
      kind: "code-search",
      threadId,
      checkoutId,
      scope: "path",
      query: "main",
      matches,
      truncated,
      observedAt: "2026-08-14T08:00:00.000Z",
    },
  } as unknown as CodeSearchResult;
}

function client(result: CodeSearchResult) {
  return { search: vi.fn(async () => result) };
}

function chord(key: string, shiftKey = false): void {
  fireEvent.keyDown(window, { key, metaKey: true, ctrlKey: true, shiftKey });
}

describe("CodeSearchDialog", () => {
  it("stays closed until a chord opens it", () => {
    render(
      <CodeSearchDialog
        checkoutId={checkoutId}
        client={client(searched([]))}
        onOpenFile={vi.fn()}
        threadId={threadId}
      />,
    );

    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("finds a file by name and opens the one the user picks", async () => {
    const user = userEvent.setup();
    const onOpenFile = vi.fn();
    const search = client(searched([{ scope: "path", fileId, path: "src/main.ts" }]));
    render(
      <CodeSearchDialog
        checkoutId={checkoutId}
        client={search}
        onOpenFile={onOpenFile}
        threadId={threadId}
      />,
    );

    chord("p");
    await user.type(await screen.findByRole("combobox"), "main");

    expect(await screen.findByRole("option", { name: /src\/main\.ts/ })).toBeVisible();
    expect(search.search.mock.calls[0]?.[0]).toMatchObject({ scope: "path", query: "main" });

    await user.keyboard("{Enter}");
    expect(onOpenFile).toHaveBeenCalledWith("src/main.ts");
  });

  it("searches file contents under the other chord and shows where the text was found", async () => {
    const user = userEvent.setup();
    const search = client(
      searched([
        {
          scope: "content",
          fileId,
          path: "src/main.ts",
          line: 12,
          column: 3,
          preview: "  const answer = 42;",
        },
      ]),
    );
    render(
      <CodeSearchDialog
        checkoutId={checkoutId}
        client={search}
        onOpenFile={vi.fn()}
        threadId={threadId}
      />,
    );

    chord("f", true);
    await user.type(await screen.findByRole("combobox"), "answer");

    expect(await screen.findByRole("option", { name: /src\/main\.ts:12/ })).toBeVisible();
    expect(screen.getByText("const answer = 42;")).toBeVisible();
    expect(search.search.mock.calls[0]?.[0]).toMatchObject({ scope: "content" });
  });

  it("says the host stopped early rather than presenting a bounded walk as everything", async () => {
    const user = userEvent.setup();
    render(
      <CodeSearchDialog
        checkoutId={checkoutId}
        client={client(searched([{ scope: "path", fileId, path: "src/main.ts" }], true))}
        onOpenFile={vi.fn()}
        threadId={threadId}
      />,
    );

    chord("p");
    await user.type(await screen.findByRole("combobox"), "main");

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        /stopped before searching the whole repository/,
      ),
    );
  });

  it("reports the host's failure instead of an empty result that reads as no match", async () => {
    const user = userEvent.setup();
    render(
      <CodeSearchDialog
        checkoutId={checkoutId}
        client={{
          search: vi.fn(async () => ({
            status: "failed" as const,
            failure: { category: "unavailable" as const, message: "Code search is unavailable." },
          })),
        }}
        onOpenFile={vi.fn()}
        threadId={threadId}
      />,
    );

    chord("p");
    await user.type(await screen.findByRole("combobox"), "main");

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Code search is unavailable."),
    );
  });

  it("keeps the typed query when the other chord switches scope", async () => {
    const user = userEvent.setup();
    const search = client(searched([]));
    render(
      <CodeSearchDialog
        checkoutId={checkoutId}
        client={search}
        onOpenFile={vi.fn()}
        threadId={threadId}
      />,
    );

    chord("p");
    await user.type(await screen.findByRole("combobox"), "answer");
    chord("f", true);

    expect(screen.getByRole("combobox")).toHaveValue("answer");
    await waitFor(() =>
      expect(search.search.mock.calls.at(-1)?.[0]).toMatchObject({
        scope: "content",
        query: "answer",
      }),
    );
  });

  it("closes when the same chord fires again", async () => {
    render(
      <CodeSearchDialog
        checkoutId={checkoutId}
        client={client(searched([]))}
        onOpenFile={vi.fn()}
        threadId={threadId}
      />,
    );

    chord("p");
    expect(await screen.findByRole("combobox")).toBeVisible();
    chord("p");
    await waitFor(() => expect(screen.queryByRole("combobox")).toBeNull());
  });
});
