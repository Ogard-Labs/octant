import type { ProjectAgentPage } from "@octant/contracts/project-browser";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  OWN_PAGE_TAB,
  ProjectAgentPageStrip,
  ProjectAgentPageView,
  SIGNED_IN_PAGE_COPY,
} from "./ProjectAgentPages";

const research: ProjectAgentPage = {
  threadId: "00000000-0000-4000-8000-0000000000a1" as never,
  contextId: "00000000-0000-4000-8000-0000000000b1" as never,
  threadTitle: "Research pricing",
  title: "Pricing | Example",
  host: "example.com",
  agentActive: true,
};
const signup: ProjectAgentPage = {
  threadId: "00000000-0000-4000-8000-0000000000a2" as never,
  contextId: "00000000-0000-4000-8000-0000000000b2" as never,
  threadTitle: "Fix the signup form",
  host: "localhost:5173",
  agentActive: false,
};
const signedIn: ProjectAgentPage = {
  threadId: "00000000-0000-4000-8000-0000000000a3" as never,
  contextId: "00000000-0000-4000-8000-0000000000b3" as never,
  threadTitle: "Check the dashboard",
  agentActive: false,
  signedIn: true,
};

describe("ProjectAgentPageStrip", () => {
  it("names each page and the thread that owns it, and marks the one an agent drives", () => {
    render(
      <ProjectAgentPageStrip
        onSelect={() => undefined}
        pages={[research, signup, signedIn]}
        selected={OWN_PAGE_TAB}
      />,
    );
    const rail = screen.getByRole("tablist", {
      name: "Agent pages in this Project",
    });
    expect(rail).toBeInTheDocument();
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(4);

    const [own, pricing, form, dashboard] = tabs;
    expect(own).toHaveTextContent("Your page");
    expect(own).toHaveAttribute("aria-selected", "true");
    // The page's title and the thread's title, with the mark while it drives.
    expect(pricing).toHaveTextContent("Pricing | Example");
    expect(pricing).toHaveTextContent("Research pricing");
    expect(pricing).toHaveTextContent("Agent active");
    // With no title the host stands in, and an idle page carries no mark.
    expect(form).toHaveTextContent("localhost:5173");
    expect(form).toHaveTextContent("Fix the signup form");
    expect(form).not.toHaveTextContent("Agent active");
    // A signed-in page seen from a paired device names no title or host.
    expect(dashboard).toHaveTextContent(SIGNED_IN_PAGE_COPY);
    expect(dashboard).toHaveTextContent("Check the dashboard");
  });

  it("selects a page by its thread and draws nothing when there are none", () => {
    const onSelect = vi.fn();
    const { container, rerender } = render(
      <ProjectAgentPageStrip
        onSelect={onSelect}
        pages={[research, signup]}
        selected={OWN_PAGE_TAB}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: /Fix the signup form/ }));
    expect(onSelect).toHaveBeenCalledWith(String(signup.threadId));

    rerender(<ProjectAgentPageStrip onSelect={onSelect} pages={[]} selected={OWN_PAGE_TAB} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("ProjectAgentPageView", () => {
  const snapshot = {
    status: "running" as const,
    threadId: research.threadId,
    evidence: [],
    observation: {
      stale: false,
      screenshotDataUrl: "data:image/png;base64,AAAA",
      title: "Pricing | Example",
    },
  };

  it("shows the thread's own picture read-only and opens the owning thread", async () => {
    const onOpenThread = vi.fn();
    const client = { agentPageSnapshot: vi.fn(async () => snapshot as never) };
    render(<ProjectAgentPageView client={client} onOpenThread={onOpenThread} page={research} />);

    await waitFor(() =>
      expect(screen.getByRole("img", { name: "Picture of Pricing | Example" })).toBeInTheDocument(),
    );
    expect(client.agentPageSnapshot).toHaveBeenCalledWith(
      { threadId: research.threadId },
      expect.any(AbortSignal),
    );
    expect(screen.getByText(/you cannot click in it from here/i)).toBeInTheDocument();
    // No address bar, no controls on the page itself.
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Open thread/ }));
    expect(onOpenThread).toHaveBeenCalledWith(String(research.threadId), "Research pricing");
  });

  it("asks for no picture of a signed-in page a paired device may not see", () => {
    const client = { agentPageSnapshot: vi.fn(async () => snapshot as never) };
    render(<ProjectAgentPageView client={client} page={signedIn} />);
    expect(screen.getAllByText(SIGNED_IN_PAGE_COPY).length).toBeGreaterThan(0);
    expect(client.agentPageSnapshot).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /Open thread/ })).toBeNull();
  });
});
