import type {
  ProjectBrowserCommand,
  ProjectBrowserResult,
} from "@octant/contracts/project-browser";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ZenProjectResearchDock } from "./ZenProjectResearchDock";

const projectId = "00000000-0000-4000-8000-000000000071" as never;
const subjectId = "00000000-0000-4000-8000-000000000072" as never;
const contextId = "00000000-0000-4000-8000-000000000073" as never;
const dock = {
  project: { hostId: "local" as never, projectId, mode: "work" as const },
  width: 480,
  collapsed: false,
};

function browser(page?: { readonly title: string; readonly url: string }): ProjectBrowserResult {
  return {
    kind: "project-browser",
    browser: {
      projectId,
      mode: "work",
      subjectId,
      ...(page === undefined
        ? {}
        : {
            context: { contextId, state: "active", presentation: "headless" },
            page: { ...page, screenshotDataUrl: "data:image/png;base64,AAAA" },
          }),
    },
  };
}

function client(answer: (command: ProjectBrowserCommand) => ProjectBrowserResult) {
  return {
    execute: vi.fn(async (command: ProjectBrowserCommand) => answer(command)),
  };
}

describe("ZenProjectResearchDock", () => {
  it("opens the address the person typed for this Project and shows the host's picture of it", async () => {
    const pages = client((command) =>
      command.kind === "open"
        ? browser({ title: "Example", url: "https://example.com/" })
        : browser(),
    );
    render(
      <ZenProjectResearchDock
        client={pages}
        dock={dock}
        onCollapse={() => undefined}
        onUndock={() => undefined}
      />,
    );

    expect(screen.getByText(/no agent can see or use this page/i)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Project browser address" }), {
      target: { value: "https://example.com/" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    await waitFor(() =>
      expect(screen.getByRole("img", { name: "Picture of Example" })).toBeInTheDocument(),
    );
    expect(pages.execute).toHaveBeenCalledWith({
      kind: "open",
      projectId,
      url: "https://example.com/",
    });
  });

  it("says what the host said when the Project's page was closed", async () => {
    const revoked = client(() => ({
      kind: "project-browser-refused",
      reason: "authority-revoked",
      message: "This Project is archived, so its page closed.",
    }));
    render(
      <ZenProjectResearchDock
        client={revoked}
        dock={dock}
        onCollapse={() => undefined}
        onUndock={() => undefined}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "This Project is archived, so its page closed.",
      ),
    );
  });

  it("closes the Project's page when the dock is closed", async () => {
    const pages = client(() => browser());
    const onUndock = vi.fn();
    render(
      <ZenProjectResearchDock
        client={pages}
        dock={dock}
        onCollapse={() => undefined}
        onUndock={onUndock}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Close Project browser" }));

    expect(onUndock).toHaveBeenCalledOnce();
    await waitFor(() => expect(pages.execute).toHaveBeenCalledWith({ kind: "stop", projectId }));
  });

  it("opens a new page in the profile the person last chose for this Project", async () => {
    globalThis.localStorage.setItem(`octant.browser.profile.${String(projectId)}`, "project");
    try {
      const pages = client((command) =>
        command.kind === "open"
          ? browser({ title: "Example", url: "https://example.com/" })
          : browser(),
      );
      render(
        <ZenProjectResearchDock
          client={pages}
          dock={dock}
          onCollapse={() => undefined}
          onUndock={() => undefined}
        />,
      );

      expect(screen.getByRole("button", { name: "Browser profile: Project" })).toBeInTheDocument();
      fireEvent.change(screen.getByRole("textbox", { name: "Project browser address" }), {
        target: { value: "https://example.com/" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Open" }));

      await waitFor(() =>
        expect(pages.execute).toHaveBeenCalledWith({
          kind: "open",
          projectId,
          url: "https://example.com/",
          profile: "project",
        }),
      );
    } finally {
      globalThis.localStorage.clear();
    }
  });

  it("opens a page Private when no profile was ever chosen", async () => {
    globalThis.localStorage.clear();
    const pages = client((command) =>
      command.kind === "open"
        ? browser({ title: "Example", url: "https://example.com/" })
        : browser(),
    );
    render(
      <ZenProjectResearchDock
        client={pages}
        dock={dock}
        onCollapse={() => undefined}
        onUndock={() => undefined}
      />,
    );

    expect(screen.getByRole("button", { name: "Browser profile: Private" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Project browser address" }), {
      target: { value: "https://example.com/" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    await waitFor(() =>
      expect(pages.execute).toHaveBeenCalledWith({
        kind: "open",
        projectId,
        url: "https://example.com/",
      }),
    );
  });

  it("shows the profile the host put the page in", async () => {
    const pages = client(() => ({
      kind: "project-browser",
      browser: {
        projectId,
        mode: "work",
        subjectId,
        context: {
          contextId,
          state: "active",
          presentation: "headless",
          profile: "personal",
        },
        page: { title: "Example", url: "https://example.com/" },
      },
    }));
    render(
      <ZenProjectResearchDock
        client={pages}
        dock={dock}
        onCollapse={() => undefined}
        onUndock={() => undefined}
      />,
    );

    expect(
      await screen.findByRole("button", { name: "Browser profile: Personal" }),
    ).toBeInTheDocument();
  });

  it("lists the Project's agent pages beside the person's and shows one read-only", async () => {
    const pages = {
      ...client(() => browser()),
      agentPages: vi.fn(async () => ({
        projectId,
        mode: "work" as const,
        pages: [
          {
            threadId: "00000000-0000-4000-8000-0000000000a1" as never,
            contextId: "00000000-0000-4000-8000-0000000000b1" as never,
            threadTitle: "Research pricing",
            title: "Pricing",
            host: "example.com",
            agentActive: true,
          },
        ],
      })),
      agentPageSnapshot: vi.fn(async () => ({
        status: "running" as const,
        threadId: "00000000-0000-4000-8000-0000000000a1" as never,
        evidence: [],
        observation: {
          stale: false,
          screenshotDataUrl: "data:image/png;base64,AAAA",
        },
      })),
    };
    const onOpenThread = vi.fn();
    render(
      <ZenProjectResearchDock
        client={pages as never}
        dock={dock}
        onCollapse={() => undefined}
        onOpenThread={onOpenThread}
        onUndock={() => undefined}
      />,
    );

    const tab = await screen.findByRole("tab", { name: /Research pricing/ });
    expect(tab).toHaveTextContent("Agent active");
    expect(pages.agentPages).toHaveBeenCalledWith(
      { projectId, mode: "work" },
      expect.any(AbortSignal),
    );
    fireEvent.click(tab);
    await waitFor(() =>
      expect(screen.getByRole("img", { name: "Picture of Pricing" })).toBeInTheDocument(),
    );
    // The person's own address bar gives way to the thread's read-only page.
    expect(screen.queryByRole("textbox", { name: "Project browser address" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Open thread/ }));
    expect(onOpenThread).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-0000000000a1",
      "Research pricing",
      "work",
    );
    fireEvent.click(screen.getByRole("tab", { name: /Your page/ }));
    expect(
      await screen.findByRole("textbox", { name: "Project browser address" }),
    ).toBeInTheDocument();
  });

  it("draws no strip when the host lists no agent page or cannot", async () => {
    const pages = {
      ...client(() => browser()),
      agentPages: vi.fn(async () => {
        throw new Error("unavailable");
      }),
    };
    render(
      <ZenProjectResearchDock
        client={pages as never}
        dock={dock}
        onCollapse={() => undefined}
        onUndock={() => undefined}
      />,
    );
    await waitFor(() => expect(pages.agentPages).toHaveBeenCalled());
    expect(screen.queryByRole("tablist")).toBeNull();
  });
});
