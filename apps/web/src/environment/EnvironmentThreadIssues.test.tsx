import { decodeThreadTouchedIssues } from "@octant/contracts";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { EnvironmentThreadIssues } from "./EnvironmentThreadIssues";

const issues = decodeThreadTouchedIssues({
  items: [
    {
      forge: "linear",
      identifier: "ENG-991",
      url: "https://linear.app/ogard/issue/ENG-991/hover-card",
      title: "Hover card",
      state: "In Progress",
      observedAt: "2026-11-24T09:00:00.000Z",
    },
    {
      forge: "linear",
      identifier: "ENG-12",
      title: "No address given",
      observedAt: "2026-11-24T08:30:00.000Z",
    },
    {
      forge: "github",
      owner: "acme",
      repository: "site",
      number: 3,
      title: "Docs are stale",
      state: "closed",
      observedAt: "2026-11-24T08:00:00.000Z",
    },
  ],
  hiddenCount: 0,
});

describe("EnvironmentThreadIssues", () => {
  it("lists every issue a thread touched in its Environment tool and opens each one's page", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<EnvironmentThreadIssues issues={issues} onOpen={onOpen} />);

    expect(screen.getByRole("group", { name: "Issues" })).toBeVisible();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);

    await user.click(
      screen.getByRole("button", { name: "Linear issue ENG-991, Hover card, In Progress" }),
    );
    expect(onOpen).toHaveBeenCalledWith("https://linear.app/ogard/issue/ENG-991/hover-card");

    await user.click(
      screen.getByRole("button", { name: "GitHub issue #3, Docs are stale, acme/site, closed" }),
    );
    expect(onOpen).toHaveBeenLastCalledWith("https://github.com/acme/site/issues/3");

    // A Linear issue whose call gave no address is a fact, not a dead link.
    expect(
      screen.getByRole("group", { name: "Linear issue ENG-12, No address given" }),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: /ENG-12/ })).toBeNull();
  });

  it("draws nothing for a thread that touched no issues", () => {
    const { container } = render(
      <EnvironmentThreadIssues issues={{ items: [], hiddenCount: 0 }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
