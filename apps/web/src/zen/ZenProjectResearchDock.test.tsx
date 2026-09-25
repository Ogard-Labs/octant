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
  return { execute: vi.fn(async (command: ProjectBrowserCommand) => answer(command)) };
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
});
