import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { decodeCodeConversationPage } from "@octant/contracts/code-operations";
import { describe, expect, it } from "vitest";
import { CodeTurnChangedFilesCard } from "./CodeTurnChangedFilesCard";

type ChangedFiles = NonNullable<
  ReturnType<typeof decodeCodeConversationPage>["turns"][number]["changedFiles"]
>;

function record(paths: ReadonlyArray<string>, extra: Partial<ChangedFiles> = {}): ChangedFiles {
  const page = decodeCodeConversationPage({
    version: 3,
    threadId: "90000000-0000-4000-8000-000000000002",
    turns: [
      {
        operationId: "90000000-0000-4000-8000-000000000011",
        providerInstanceId: "90000000-0000-4000-8000-000000000012",
        modelId: "model-one",
        sessionId: "90000000-0000-4000-8000-000000000004",
        prompt: {
          contentId: "90000000-0000-4000-8000-000000000013",
          digest: "d".repeat(64),
          byteLength: 4,
        },
        assistant: [],
        status: "completed",
        startedAt: "2026-07-21T12:00:00.000Z",
        updatedAt: "2026-07-21T12:01:00.000Z",
        changedFiles: {
          files: paths.map((path, index) => ({ path, insertions: index + 1, deletions: index })),
          total: paths.length,
          truncated: false,
          ...extra,
        },
      },
    ],
    nextCursor: 1,
    hasMore: false,
  });
  const changedFiles = page.turns[0]?.changedFiles;
  if (changedFiles === undefined) throw new Error("fixture lost its record");
  return changedFiles;
}

describe("the files a Code turn changed", () => {
  it("names each path with its line counts, and never says who wrote it", () => {
    render(<CodeTurnChangedFilesCard changedFiles={record(["src/app.ts", "README.md"])} />);

    const card = screen.getByRole("region", { name: "Files changed while this ran" });
    expect(within(card).getByRole("heading")).toHaveTextContent("2 files changed while this ran");
    const rows = within(card).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("src/app.ts");
    expect(rows[0]).toHaveTextContent("+1");
    expect(rows[1]).toHaveTextContent("README.md");
    expect(rows[1]).toHaveTextContent("−1");
    // An observation, not an attribution: another process may have written it.
    expect(card).not.toHaveTextContent(/wrote|created|edited by/i);
  });

  it("folds a long list behind one line so it cannot bury the reply", async () => {
    const user = userEvent.setup();
    const paths = Array.from({ length: 8 }, (_, index) => `src/file-${index}.ts`);
    render(<CodeTurnChangedFilesCard changedFiles={record(paths)} />);

    expect(screen.getAllByRole("listitem")).toHaveLength(5);
    const fold = screen.getByRole("button", { name: "Show 3 more" });
    expect(fold).toHaveAttribute("aria-expanded", "false");
    await user.click(fold);
    expect(screen.getAllByRole("listitem")).toHaveLength(8);
    expect(screen.getByRole("button", { name: "Show fewer" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("says when the list is incomplete instead of summing what it never saw", () => {
    render(
      <CodeTurnChangedFilesCard
        changedFiles={record(["src/app.ts"], { total: 40, truncated: true })}
      />,
    );

    expect(screen.getByRole("heading")).toHaveTextContent("40 files changed while this ran");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Showing 1 of 40. Review has the whole change.",
    );
    // A total over one listed row would read as the whole change's size.
    expect(screen.getByRole("heading").parentElement).not.toHaveTextContent("+1");
  });

  it("marks a binary file rather than printing zero lines for it", () => {
    const changedFiles = record(["assets/logo.png"]);
    render(
      <CodeTurnChangedFilesCard
        changedFiles={{
          ...changedFiles,
          files: changedFiles.files.map((file) => ({ ...file, binary: true as const })),
        }}
      />,
    );
    expect(screen.getByRole("listitem")).toHaveTextContent("Binary");
  });
});
