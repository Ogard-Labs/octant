import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TrackerReferenceProvider } from "./TrackerReferenceContext";
import { TrackerReferenceComposerHints } from "./TrackerReferenceComposerHints";
import { TrackerReferenceText } from "./TrackerReferenceText";
import type { TrackerReferenceResolvePorts } from "./trackerReferenceResolve";

function ports(overrides: Partial<TrackerReferenceResolvePorts> = {}): TrackerReferenceResolvePorts {
  return {
    github: {
      available: true,
      readIssue: async () => ({
        kind: "resolved",
        title: "Catalogue read",
        url: "https://github.com/octant/octant/issues/12",
        state: "open",
      }),
    },
    linear: {
      available: true,
      getIssue: async () => ({
        kind: "resolved",
        title: "Chip resolution",
        url: "https://linear.app/example/issue/ABC-99",
        state: "open",
      }),
    },
    ...overrides,
  };
}

describe("TrackerReferenceText", () => {
  it("renders a resolved tracker-key tag as a titled chip with status", async () => {
    const user = userEvent.setup();
    render(
      <TrackerReferenceProvider ports={ports()}>
        <TrackerReferenceText text="Please finish #ABC-99 today." />
      </TrackerReferenceProvider>,
    );

    const chip = await screen.findByRole("link", {
      name: "#ABC-99: Chip resolution (Open)",
    });
    expect(chip).toHaveAttribute("href", "https://linear.app/example/issue/ABC-99");
    expect(chip).toHaveTextContent("#ABC-99");
    expect(chip).toHaveTextContent("Open");

    await user.hover(chip);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Chip resolution");
    expect(screen.getByRole("tooltip")).toHaveTextContent("Open");
  });

  it("leaves a tracker-key tag as plain text when Linear is unavailable", async () => {
    const getIssue = vi.fn();
    render(
      <TrackerReferenceProvider ports={ports({ linear: { available: false, getIssue } })}>
        <TrackerReferenceText text="See #ABC-99 later." />
      </TrackerReferenceProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText(/See #ABC-99 later\./)).toBeVisible();
    });
    expect(screen.queryByRole("link")).toBeNull();
    expect(getIssue).not.toHaveBeenCalled();
  });

  it("leaves a rate-limited GitHub tag as plain text instead of inventing a title", async () => {
    render(
      <TrackerReferenceProvider
        ports={ports({
          github: {
            available: true,
            readIssue: async () => ({ kind: "unavailable", reason: "rate-limited" }),
          },
        })}
      >
        <TrackerReferenceText text="Blocked on octant/octant#12." />
      </TrackerReferenceProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText(/Blocked on octant\/octant#12\./)).toBeVisible();
    });
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("resolves a GitHub owner/name#number tag when issues-read is available", async () => {
    render(
      <TrackerReferenceProvider ports={ports()}>
        <TrackerReferenceText asParagraph text="Track octant/octant#12." />
      </TrackerReferenceProvider>,
    );

    expect(
      await screen.findByRole("link", { name: "octant/octant#12: Catalogue read (Open)" }),
    ).toBeVisible();
  });
});

describe("TrackerReferenceComposerHints", () => {
  it("lists resolved tags from the composer draft without writing them back", async () => {
    render(
      <TrackerReferenceProvider ports={ports()}>
        <TrackerReferenceComposerHints draft="Working on #ABC-99 and octant/octant#12" />
      </TrackerReferenceProvider>,
    );

    const list = await screen.findByRole("list", { name: "Resolved tracker references" });
    expect(list).toBeVisible();
    expect(await screen.findByText("Chip resolution")).toBeVisible();
    expect(screen.getByText("Catalogue read")).toBeVisible();
  });

  it("renders nothing when no connected tracker can claim the draft tags", async () => {
    render(
      <TrackerReferenceProvider
        ports={{
          github: { available: false, readIssue: vi.fn() },
          linear: { available: false, getIssue: vi.fn() },
        }}
      >
        <TrackerReferenceComposerHints draft="#ABC-99" />
      </TrackerReferenceProvider>,
    );

    await waitFor(() => {
      expect(screen.queryByRole("list", { name: "Resolved tracker references" })).toBeNull();
    });
  });
});
