import type {
  LinearIssueDetail,
  LinearIssueFilterOptions,
  LinearIssueGetInput,
  LinearIssueListInput,
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
  comments: [],
};

const filters: LinearIssueFilterOptions = {
  teams: [{ id: "22222222-2222-4222-8222-222222222222", label: "Engineering (ENG)" }],
  states: [{ id: "33333333-3333-4333-8333-333333333333", label: "In Progress" }],
  assignees: [{ id: "unassigned", label: "Unassigned" }],
  projects: [{ id: "44444444-4444-4444-8444-444444444444", label: "Octant" }],
};

function renderBrowser(
  options: {
    readonly listIssues?: (input?: LinearIssueListInput) => Promise<LinearIssueListPage>;
    readonly getIssue?: (input: LinearIssueGetInput) => Promise<LinearIssueDetail>;
    readonly listIssueFilters?: () => Promise<LinearIssueFilterOptions>;
    readonly isNarrow?: boolean;
    readonly page?: LinearIssueListPage;
  } = {},
) {
  const listIssues = options.listIssues ?? vi.fn(async () => options.page ?? page);
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

  it("caps search length and retains the last valid query when decoding fails", async () => {
    const user = userEvent.setup();
    const { listIssues } = renderBrowser();
    const search = await screen.findByRole("searchbox", { name: "Search Linear issues" });
    expect(search).toHaveAttribute("maxLength", "128");
    await user.type(search, "browse");
    await waitFor(() =>
      expect(listIssues).toHaveBeenCalledWith(expect.objectContaining({ search: "browse" })),
    );
    await user.clear(search);
    await user.type(search, "lin_api_abcdefghijklmnop");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(listIssues).not.toHaveBeenCalledWith(
      expect.objectContaining({ search: "lin_api_abcdefghijklmnop" }),
    );
  });

  it("ignores a slower detail response after a later issue is selected", async () => {
    const user = userEvent.setup();
    const later: LinearIssueRow = {
      ...row,
      id: "22222222-2222-4222-8222-222222222222",
      identifier: "ENG-13",
      title: "Later issue",
      url: "https://linear.app/ogard-labs/issue/ENG-13",
    };
    let releaseFirst: ((value: LinearIssueDetail) => void) | undefined;
    const firstDetail = new Promise<LinearIssueDetail>((resolve) => {
      releaseFirst = resolve;
    });
    const getIssue = vi.fn(async (input: LinearIssueGetInput) => {
      if (input.id === row.id) return firstDetail;
      return {
        ...later,
        description: "Later description.",
        descriptionTruncated: false,
        comments: [],
      };
    });
    renderBrowser({
      getIssue,
      page: { rows: [row, later], hasNextPage: false },
    });
    await user.click(await screen.findByRole("button", { name: /ENG-12/ }));
    await user.click(await screen.findByRole("button", { name: /ENG-13/ }));
    expect(await screen.findByRole("article", { name: "ENG-13" })).toBeVisible();
    expect(screen.getByText("Later description.")).toBeVisible();
    releaseFirst?.({ ...detail });
    await Promise.resolve();
    expect(screen.getByRole("article", { name: "ENG-13" })).toBeVisible();
    expect(screen.queryByText("Read-only description.")).not.toBeInTheDocument();
  });

  it("ignores a slower Load more response after the query changes", async () => {
    const user = userEvent.setup();
    const later: LinearIssueRow = {
      ...row,
      id: "22222222-2222-4222-8222-222222222222",
      identifier: "ENG-13",
      title: "Later page",
      url: "https://linear.app/ogard-labs/issue/ENG-13",
    };
    const searched: LinearIssueRow = {
      ...row,
      id: "33333333-3333-4333-8333-333333333333",
      identifier: "ENG-14",
      title: "Search hit",
      url: "https://linear.app/ogard-labs/issue/ENG-14",
    };
    let releaseMore: ((value: LinearIssueListPage) => void) | undefined;
    const morePage = new Promise<LinearIssueListPage>((resolve) => {
      releaseMore = resolve;
    });
    const listIssues = vi.fn(async (input?: LinearIssueListInput) => {
      if (input?.cursor === "page-2") return morePage;
      if (input?.search === "browse") {
        return { rows: [searched], hasNextPage: false };
      }
      return { rows: [row], hasNextPage: true, endCursor: "page-2" };
    });
    renderBrowser({ listIssues });
    expect(await screen.findByText("ENG-12")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Load more" }));
    await user.type(screen.getByRole("searchbox", { name: "Search Linear issues" }), "browse");
    expect(await screen.findByText("ENG-14")).toBeVisible();
    expect(screen.queryByText("ENG-12")).not.toBeInTheDocument();
    releaseMore?.({ rows: [later], hasNextPage: false });
    await Promise.resolve();
    expect(screen.getByText("ENG-14")).toBeVisible();
    expect(screen.queryByText("ENG-13")).not.toBeInTheDocument();
    expect(screen.queryByText("ENG-12")).not.toBeInTheDocument();
  });

  it("ignores a slower Retry response after the query changes", async () => {
    const user = userEvent.setup();
    const searched: LinearIssueRow = {
      ...row,
      id: "33333333-3333-4333-8333-333333333333",
      identifier: "ENG-14",
      title: "Search hit",
      url: "https://linear.app/ogard-labs/issue/ENG-14",
    };
    let releaseRetry: ((value: LinearIssueListPage) => void) | undefined;
    const retryPage = new Promise<LinearIssueListPage>((resolve) => {
      releaseRetry = resolve;
    });
    let attempts = 0;
    const listIssues = vi.fn(async (input?: LinearIssueListInput) => {
      if (input?.search === "browse") {
        return { rows: [searched], hasNextPage: false };
      }
      attempts += 1;
      if (attempts === 1) throw new Error("Linear is unavailable.");
      return retryPage;
    });
    renderBrowser({ listIssues });
    expect(await screen.findByRole("heading", { name: "Issues unavailable" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await user.type(screen.getByRole("searchbox", { name: "Search Linear issues" }), "browse");
    expect(await screen.findByText("ENG-14")).toBeVisible();
    releaseRetry?.({ rows: [row], hasNextPage: false });
    await Promise.resolve();
    expect(screen.getByText("ENG-14")).toBeVisible();
    expect(screen.queryByText("ENG-12")).not.toBeInTheDocument();
  });

  it("keeps the selected row background under hover and focus", () => {
    expect(stylesheet).toMatch(
      /\.linear-issues__row\[aria-pressed="true"\]:hover,\s*\.linear-issues__row\[aria-pressed="true"\]:focus-visible\s*\{\s*background:\s*var\(--accent\)/,
    );
  });
});
