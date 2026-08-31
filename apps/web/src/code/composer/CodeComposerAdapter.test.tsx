import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CodeComposerAdapter } from "./CodeComposerAdapter";
import type { ProjectId } from "@octant/contracts/projects";

const defaultProps = {
  projectId: "00000000-0000-0000-0000-000000000001" as ProjectId,
  projectName: "My Repo",
  projectRoot: "/home/user/repo",
  branchName: "development",
  defaultExecutionPolicy: "approval-gated" as const,
  defaultPermissionPersistence: "current-session" as const,
  providerGroups: [],
  onSelectProvider: () => {},
  onCreateThread: () => {},
  onCancel: () => {},
};

describe("CodeComposerAdapter", () => {
  it("renders composer with project and branch context", () => {
    const html = renderToStaticMarkup(<CodeComposerAdapter {...defaultProps} />);
    expect(html).toContain("What should we build");
    expect(html).toContain("My Repo");
    expect(html).toContain("development");
  });

  it("keeps the welcome prompt on the shared composer frame", () => {
    const html = renderToStaticMarkup(<CodeComposerAdapter {...defaultProps} />);
    expect(html).toContain('class="composer code-composer-adapter__card"');
  });

  it("names the Project in the heading and tucks host, checkout, and branch on a second card", () => {
    const { container } = render(<CodeComposerAdapter {...defaultProps} />);
    const frame = container.querySelector(".composer");
    const dock = container.querySelector(".code-composer-adapter__dock");
    expect(screen.getByRole("heading", { name: /What should we build in My Repo/ })).toBeVisible();
    expect(frame).not.toBeNull();
    expect(dock).not.toBeNull();
    expect(frame?.querySelector(".host-selector")).toBeNull();
    expect(frame?.textContent).not.toContain("My Repo");
    expect(dock?.querySelector(".host-selector")).not.toBeNull();
    expect(dock?.textContent).toContain("Current checkout");
    expect(dock?.textContent).toContain("development");
  });

  it("keeps GitHub and delivery outside the raised composer frame", () => {
    const { container } = render(
      <CodeComposerAdapter {...defaultProps} githubControl={<span>GitHub control slot</span>} />,
    );
    const frame = container.querySelector(".composer");
    const strip = container.querySelector(".code-composer-adapter__context-strip");
    expect(frame).not.toBeNull();
    expect(strip).not.toBeNull();
    expect(frame?.contains(strip)).toBe(false);
    expect(strip?.textContent).toContain("GitHub control slot");
    expect(strip?.textContent).toContain("Delivery target");
  });

  it("renders approval policy selector", () => {
    const html = renderToStaticMarkup(<CodeComposerAdapter {...defaultProps} />);
    expect(html).toContain("Approval");
    expect(html).toContain("Access policy");
  });

  it("renders delivery disclosure toggle", () => {
    const html = renderToStaticMarkup(<CodeComposerAdapter {...defaultProps} />);
    expect(html).toContain("Delivery target");
    expect(html).toContain('aria-expanded="false"');
  });

  it("uses the server-observed GitHub repository as the delivery default", () => {
    render(<CodeComposerAdapter {...defaultProps} baseRepository="acme/octant" />);

    fireEvent.click(screen.getByRole("button", { name: "Delivery target" }));

    expect(screen.getByRole("textbox", { name: "Base repository" })).toHaveValue("acme/octant");
  });

  it("renders disabled send button when empty", () => {
    const html = renderToStaticMarkup(<CodeComposerAdapter {...defaultProps} />);
    expect(html).toContain('aria-label="Create thread"');
    expect(html).toContain("disabled");
  });

  it("blocks Code submission when the selected Project is unavailable", () => {
    const html = renderToStaticMarkup(
      <CodeComposerAdapter {...defaultProps} projectAvailable={false} />,
    );

    expect(html).toContain("The selected Project is unavailable. Choose another Project.");
    expect(html).toContain('aria-label="Create thread"');
    expect(html).toContain("disabled");
  });

  it("does not show unavailable-project guidance before a Project is selected", () => {
    const { projectId: _projectId, projectName: _projectName, ...withoutProject } = defaultProps;
    const html = renderToStaticMarkup(
      <CodeComposerAdapter {...withoutProject} projectAvailable={false} />,
    );

    expect(html).not.toContain("The selected Project is unavailable");
  });

  it("renders error message when provided", () => {
    const html = renderToStaticMarkup(
      <CodeComposerAdapter {...defaultProps} errorMessage="Checkout failed" />,
    );
    expect(html).toContain("Checkout failed");
    expect(html).toContain('role="alert"');
  });

  it("renders creating state", () => {
    const html = renderToStaticMarkup(<CodeComposerAdapter {...defaultProps} creating />);
    expect(html).toContain("disabled");
  });

  it("renders the multi-model pool control slot in the composer bar", () => {
    const html = renderToStaticMarkup(
      <CodeComposerAdapter {...defaultProps} poolControl={<span>Pool control slot</span>} />,
    );
    expect(html).toContain("Pool control slot");
  });

  it("renders no pool control when the slot is not provided", () => {
    const html = renderToStaticMarkup(<CodeComposerAdapter {...defaultProps} />);
    expect(html).not.toContain("Pool control slot");
  });

  it("renders the GitHub repository control slot as a distinct context-strip selection", () => {
    const html = renderToStaticMarkup(
      <CodeComposerAdapter {...defaultProps} githubControl={<span>GitHub control slot</span>} />,
    );
    // Host, Project, and GitHub repository stay distinct visible selections.
    expect(html).toContain("host-selector");
    expect(html).toContain("My Repo");
    expect(html).toContain("GitHub control slot");
  });

  it("renders no GitHub control when the slot is not provided", () => {
    const html = renderToStaticMarkup(<CodeComposerAdapter {...defaultProps} />);
    expect(html).not.toContain("GitHub control slot");
  });

  it("renders a default-enabled Start from origin control only when server-authoritative remote facts are provided", () => {
    const html = renderToStaticMarkup(
      <CodeComposerAdapter
        {...defaultProps}
        // Start from origin only decides where a new worktree branches from,
        // so it belongs to the managed-worktree workspace.
        newThreadWorkspace="managed-worktree"
        worktreeRemoteFacts={{ remotes: ["origin"], defaultRemote: "origin" }}
      />,
    );
    expect(html).toContain("Start from origin");
    expect(html).toContain("Fetch and start from origin/development");
    expect(html).toContain('aria-checked="true"');
  });

  it("F4: disables Start from origin when no server-authoritative remote facts are provided", () => {
    const html = renderToStaticMarkup(<CodeComposerAdapter {...defaultProps} />);
    // The control may still render, but it must not be checked/enabled.
    expect(html).not.toContain('aria-checked="true"');
  });

  it("F4: disables Start from origin when remotes are ambiguous", () => {
    const html = renderToStaticMarkup(
      <CodeComposerAdapter
        {...defaultProps}
        worktreeRemoteFacts={{ remotes: ["origin", "upstream"] }}
      />,
    );
    expect(html).not.toContain('aria-checked="true"');
  });

  it("F2: defaults the delivery branch to a unique octant/<id> that does not collide with the base branch", async () => {
    // The delivery section is collapsed by default; verify via interaction
    // that the submitted branchIntent is octant/<id>, not the base branch.
    // See the F2 interaction test below for the authoritative assertion.
    // Here we only confirm the base branch context still renders.
    const html = renderToStaticMarkup(<CodeComposerAdapter {...defaultProps} />);
    expect(html).toContain("development");
  });

  it("omits the Start from origin control when no repository is selected", () => {
    const html = renderToStaticMarkup(
      <CodeComposerAdapter
        defaultExecutionPolicy="approval-gated"
        defaultPermissionPersistence="current-session"
        onCancel={() => {}}
        onCreateThread={() => {}}
        onSelectProvider={() => {}}
        providerGroups={[]}
      />,
    );
    expect(html).not.toContain("Start from origin");
  });
});

// Interaction coverage beyond static markup.
import { createRoot } from "react-dom/client";
import { act } from "react";

describe("CodeComposerAdapter interactions", () => {
  it("defaults Start from origin when authoritative remote facts arrive after mount", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<CodeComposerAdapter {...defaultProps} newThreadWorkspace="managed-worktree" />);
    });
    expect(container.querySelector('[role="switch"]')).toHaveAttribute("aria-checked", "false");

    await act(async () => {
      root.render(
        <CodeComposerAdapter
          {...defaultProps}
          newThreadWorkspace="managed-worktree"
          worktreeRemoteFacts={{ remotes: ["origin"], defaultRemote: "origin" }}
        />,
      );
    });

    expect(container.querySelector('[role="switch"]')).toHaveAttribute("aria-checked", "true");
    root.unmount();
    container.remove();
  });

  it("reports the requested access policy when the composer access dropdown changes", async () => {
    const onExecutionPolicyChange = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <CodeComposerAdapter
          {...defaultProps}
          defaultExecutionPolicy="approval-gated"
          onExecutionPolicyChange={onExecutionPolicyChange}
        />,
      );
    });
    expect(onExecutionPolicyChange).toHaveBeenCalledWith("approval-gated");
    const access = screen.getByRole("button", { name: "Access policy" });
    await act(async () => {
      fireEvent.click(access);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: /Plan/ }));
    });
    expect(onExecutionPolicyChange).toHaveBeenCalledWith("plan");
    root.unmount();
    container.remove();
  });

  it("submits on Enter and cancels on Escape", async () => {
    const onCreateThread = vi.fn();
    const onCancel = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <CodeComposerAdapter
          projectId={"00000000-0000-0000-0000-000000000001" as any}
          defaultExecutionPolicy="approval-gated"
          defaultPermissionPersistence="current-session"
          providerGroups={[]}
          onSelectProvider={() => {}}
          onCreateThread={onCreateThread}
          onCancel={onCancel}
        />,
      );
    });
    const textarea = container.querySelector("textarea");
    expect(textarea).not.toBeNull();
    await act(async () => {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      nativeInputValueSetter?.call(textarea, "Ship the fix");
      textarea!.dispatchEvent(new Event("input", { bubbles: true }));
      textarea!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onCreateThread).toHaveBeenCalled();
    await act(async () => {
      textarea!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onCancel).toHaveBeenCalled();
    root.unmount();
    container.remove();
  });

  /**
   * A Code thread belongs to a Project (decision 0035). Enter must not start a
   * first turn while no Project is chosen, or the thread would run against a
   * root nobody picked.
   */
  it("refuses to start the first turn until a Project is chosen", async () => {
    const onCreateThread = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <CodeComposerAdapter
          defaultExecutionPolicy="approval-gated"
          defaultPermissionPersistence="current-session"
          providerGroups={[]}
          onSelectProvider={() => {}}
          onCreateThread={onCreateThread}
          onCancel={() => {}}
        />,
      );
    });
    const textarea = container.querySelector("textarea");
    await act(async () => {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      nativeInputValueSetter?.call(textarea, "Ship the fix");
      textarea!.dispatchEvent(new Event("input", { bubbles: true }));
      textarea!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    expect(onCreateThread).not.toHaveBeenCalled();
    expect(container.querySelector('[aria-label="Create thread"]')).toBeDisabled();
    root.unmount();
    container.remove();
  });

  it("F4: carries startFromOrigin=false on the submit input when no server-authoritative remote facts are provided", async () => {
    const onCreateThread = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <CodeComposerAdapter
          projectId={"00000000-0000-0000-0000-000000000001" as any}
          projectName="My Repo"
          defaultExecutionPolicy="approval-gated"
          defaultPermissionPersistence="current-session"
          providerGroups={[]}
          onSelectProvider={() => {}}
          onCreateThread={onCreateThread}
          onCancel={() => {}}
        />,
      );
    });
    const textarea = container.querySelector("textarea");
    await act(async () => {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      nativeInputValueSetter?.call(textarea, "Ship the fix");
      textarea!.dispatchEvent(new Event("input", { bubbles: true }));
      textarea!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onCreateThread).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeSource: { startFromOrigin: false, remoteName: "origin" },
      }),
    );
    root.unmount();
    container.remove();
  });

  it("F2: carries a non-colliding octant/<id> branchIntent on the submit input", async () => {
    const onCreateThread = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <CodeComposerAdapter
          projectId={"00000000-0000-0000-0000-000000000001" as any}
          projectName="My Repo"
          defaultExecutionPolicy="approval-gated"
          defaultPermissionPersistence="current-session"
          providerGroups={[]}
          onSelectProvider={() => {}}
          onCreateThread={onCreateThread}
          onCancel={() => {}}
        />,
      );
    });
    const textarea = container.querySelector("textarea");
    await act(async () => {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      nativeInputValueSetter?.call(textarea, "Ship the fix");
      textarea!.dispatchEvent(new Event("input", { bubbles: true }));
      textarea!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onCreateThread).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryTarget: expect.objectContaining({
          branchIntent: expect.stringMatching(/^octant\//),
        }),
      }),
    );
    // The branchIntent must not equal the base branch.
    const call = onCreateThread.mock.calls[0]![0] as {
      deliveryTarget: { branchIntent: string; proposedBaseBranch: string };
    };
    expect(call.deliveryTarget.branchIntent).not.toBe(call.deliveryTarget.proposedBaseBranch);
    root.unmount();
    container.remove();
  });

  it("preserves an explicitly selected remote ref when remotes are ambiguous", async () => {
    const onCreateThread = vi.fn();
    const execute = vi.fn(async (command: { kind: string }) => {
      if (command.kind === "list-code-worktree-refs") {
        return {
          kind: "worktree-refs-listed",
          projectId: "00000000-0000-0000-0000-000000000001",
          refs: [
            { name: "origin/feature-only", kind: "remote", remoteName: "origin" },
            { name: "upstream/main", kind: "remote", remoteName: "upstream" },
          ],
        };
      }
      return undefined;
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <CodeComposerAdapter
          {...defaultProps}
          execute={execute as never}
          onCreateThread={onCreateThread}
          worktreeRemoteFacts={{ remotes: ["origin", "upstream"] }}
        />,
      );
    });

    const trigger = container.querySelector('button[aria-label="Base branch"]');
    expect(trigger).not.toBeNull();
    await act(async () => {
      trigger!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    const option = Array.from(document.querySelectorAll('[role="option"]')).find((node) =>
      node.textContent?.includes("origin/feature-only"),
    );
    expect(option).not.toBeUndefined();
    await act(async () => {
      option!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const textarea = container.querySelector("textarea");
    await act(async () => {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      nativeInputValueSetter?.call(textarea, "Ship the remote branch");
      textarea!.dispatchEvent(new Event("input", { bubbles: true }));
      textarea!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    expect(onCreateThread).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeSource: { startFromOrigin: true, remoteName: "origin" },
        deliveryTarget: expect.objectContaining({ proposedBaseBranch: "feature-only" }),
      }),
    );
    root.unmount();
    container.remove();
  });

  it("clears stale worktree refs when the selected project changes", async () => {
    const firstProject = "00000000-0000-0000-0000-000000000001";
    const secondProject = "00000000-0000-0000-0000-000000000002";
    const execute = vi.fn(async (command: { kind: string; projectId?: string }) => {
      if (command.kind !== "list-code-worktree-refs") return undefined;
      return {
        kind: "worktree-refs-listed",
        projectId: command.projectId,
        refs:
          command.projectId === firstProject
            ? [{ name: "project-a-only", kind: "local" }]
            : [{ name: "project-b-only", kind: "local" }],
      };
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <CodeComposerAdapter
          {...defaultProps}
          execute={execute as never}
          projectId={firstProject as never}
        />,
      );
    });
    const trigger = () => container.querySelector('button[aria-label="Base branch"]');
    await act(async () => {
      trigger()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("project-a-only");

    await act(async () => {
      root.render(
        <CodeComposerAdapter
          {...defaultProps}
          execute={execute as never}
          projectId={secondProject as never}
          projectName="Other Repo"
        />,
      );
    });
    expect(document.body.textContent).not.toContain("project-a-only");
    await act(async () => {
      trigger()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.body.textContent).not.toContain("project-a-only");
    expect(document.body.textContent).toContain("project-b-only");
    root.unmount();
    container.remove();
  });

  it("says a text-only model cannot take a pasted image instead of attaching it", async () => {
    render(
      <CodeComposerAdapter
        {...defaultProps}
        providerGroups={[
          {
            driverLabel: "OpenCode",
            endpointHost: "local",
            executionHost: "local",
            instance: {
              id: "80000000-0000-4000-8000-0000000000a1",
              displayName: "Local OpenCode",
            },
            readiness: "ready",
            sections: [
              {
                label: "Models",
                models: [
                  {
                    model: {
                      id: "model-one",
                      displayName: "Model One",
                      inputModalities: ["text"],
                    },
                  },
                ],
              },
            ],
          } as never,
        ]}
        selectedProviderInstanceId={"80000000-0000-4000-8000-0000000000a1" as never}
        selectedModelId={"model-one" as never}
      />,
    );

    const file = new File([new Uint8Array([137, 80, 78])], "pasted.png", { type: "image/png" });
    fireEvent.paste(screen.getByLabelText("First message"), {
      clipboardData: { files: [file], items: [] },
    });
    const attached = await screen.findByLabelText("Attached images");
    expect(attached).toHaveTextContent(
      "The selected model does not accept images. Choose an image-capable model.",
    );
    expect(screen.queryByAltText("pasted.png")).not.toBeInTheDocument();
  });
});
