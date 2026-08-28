import type {
  LinearIssueDetail,
  LinearIssueFilterOptions,
  LinearIssueListPage,
  LinearIssueRow,
} from "@octant/contracts/linear-issues";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LinearIssueBrowser } from "./LinearIssueBrowser";

const stylesheet = readFileSync(resolve(import.meta.dirname, "../styles.css"), "utf8");

function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "s"));
  return match?.[1] ?? "";
}

const row: LinearIssueRow = {
  id: "11111111-1111-4111-8111-111111111111",
  identifier: "ENG-12",
  title: "Browse issues in the workspace",
  state: { name: "In Progress", type: "started" },
  assignee: "Ada",
  url: "https://linear.app/ogard-labs/issue/ENG-12",
};

const page: LinearIssueListPage = {
  rows: [row],
  hasNextPage: false,
};

const detail: LinearIssueDetail = {
  ...row,
  description: "Read-only description.",
  descriptionTruncated: false,
};

const filters: LinearIssueFilterOptions = {
  teams: [{ id: "22222222-2222-4222-8222-222222222222", label: "Engineering (ENG)" }],
  states: [{ id: "33333333-3333-4333-8333-333333333333", label: "In Progress" }],
  assignees: [{ id: "unassigned", label: "Unassigned" }],
  projects: [{ id: "44444444-4444-4444-8444-444444444444", label: "Octant" }],
};

function renderBrowser(
  options: {
    readonly listIssues?: () => Promise<LinearIssueListPage>;
    readonly getIssue?: () => Promise<LinearIssueDetail>;
    readonly listIssueFilters?: () => Promise<LinearIssueFilterOptions>;
    readonly isNarrow?: boolean;
  } = {},
) {
  const listIssues = options.listIssues ?? vi.fn(async () => page);
  const getIssue = options.getIssue ?? vi.fn(async () => detail);
  const listIssueFilters = options.listIssueFilters ?? vi.fn(async () => filters);
  render(
    <LinearIssueBrowser
      getIssue={getIssue}
      listIssueFilters={listIssueFilters}
      listIssues={listIssues}
      onClose={() => undefined}
      {...(options.isNarrow === undefined ? {} : { isNarrow: options.isNarrow })}
    />,
  );
  return { listIssues, getIssue };
}

describe("Linear issue browser", () => {
  it("lists identifier, title, state, and assignee from the connected workspace", async () => {
    renderBrowser();
    expect(await screen.findByRole("heading", { name: "Linear" })).toBeVisible();
    expect(await screen.findByText("ENG-12")).toBeVisible();
    expect(screen.getByText("Browse issues in the workspace")).toBeVisible();
    expect(screen.getByText("In Progress")).toBeVisible();
    expect(screen.getByText("Ada")).toBeVisible();
  });

  it("opens an issue for description, status, and Open in Linear", async () => {
    const user = userEvent.setup();
    const { getIssue } = renderBrowser();
    await user.click(await screen.findByRole("button", { name: /ENG-12/ }));
    expect(getIssue).toHaveBeenCalledWith({ id: row.id });
    const article = await screen.findByRole("article", { name: "ENG-12" });
    expect(within(article).getByText("Read-only description.")).toBeVisible();
    expect(within(article).getByText("In Progress")).toBeVisible();
    const link = within(article).getByRole("link", { name: "Open in Linear" });
    expect(link).toHaveAttribute("href", row.url);
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("sends search to the Integration read", async () => {
    const user = userEvent.setup();
    const { listIssues } = renderBrowser();
    await screen.findByText("ENG-12");
    await user.type(screen.getByRole("searchbox", { name: "Search Linear issues" }), "browse");
    await waitFor(() =>
      expect(listIssues).toHaveBeenCalledWith(expect.objectContaining({ search: "browse" })),
    );
  });

  it("fails closed when Linear issue browse is unavailable", async () => {
    renderBrowser({
      listIssues: vi.fn(async () => {
        throw new Error("Connect Linear to authorize this host.");
      }),
    });
    expect(await screen.findByRole("heading", { name: "Issues unavailable" })).toBeVisible();
    expect(screen.getByText("Connect Linear to authorize this host.")).toBeVisible();
    expect(screen.queryByText("ENG-12")).not.toBeInTheDocument();
  });

  it("keeps list rows wrapping at a narrow width", () => {
    const meta = ruleBody(stylesheet, '.linear-issues[data-narrow="true"] .linear-issues__meta');
    expect(meta).toContain("flex-wrap: wrap");
  });
});
