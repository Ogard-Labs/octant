import type { LinearIssueListPage, LinearIssueRow } from "@octant/contracts/linear-issues";
import { render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { InboxView } from "./InboxView";

const stylesheet = readFileSync(resolve(import.meta.dirname, "../styles.css"), "utf8");

const linearRow: LinearIssueRow = {
  id: "11111111-1111-4111-8111-111111111111",
  identifier: "ENG-12",
  title: "Browse issues in the workspace",
  state: { name: "In Progress", type: "started" },
  assignee: "Ada",
  url: "https://linear.app/ogard-labs/issue/ENG-12",
};

const linearPage: LinearIssueListPage = {
  rows: [linearRow],
  hasNextPage: false,
};

describe("InboxView", () => {
  it("announces unseen GitHub and Linear rows to assistive technology", async () => {
    document.head.insertAdjacentHTML("beforeend", `<style>${stylesheet}</style>`);

    render(
      <InboxView
        attentionItems={[]}
        loadAssignedGithubWork={vi.fn(async () => ({
          kind: "assigned-work" as const,
          page: {
            items: [
              {
                category: "issue" as const,
                owner: "octant",
                name: "octant",
                number: 7,
                title: "Fix inbox",
                author: "octocat",
                updatedAt: "2026-08-28T10:00:00.000Z",
                url: "https://github.com/octant/octant/issues/7",
              },
            ],
            freshness: { status: "fresh" as const },
          },
        }))}
        loadAssignedLinearIssues={vi.fn(async () => linearPage)}
        onClose={vi.fn()}
        onOpenThread={vi.fn()}
      />,
    );

    expect(await screen.findByRole("link", { name: /Fix inbox/ })).toBeVisible();
    expect(
      await screen.findByRole("link", { name: /Browse issues in the workspace/ }),
    ).toBeVisible();

    await waitFor(() => {
      expect(screen.getAllByText("Unseen")).toHaveLength(2);
    });
    for (const label of screen.getAllByText("Unseen")) {
      expect(label).toHaveClass("sr-only");
    }
  });
});
