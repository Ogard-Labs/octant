import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { OctantHostBridge } from "../shell/hostBridge";
import {
  bindingReceipt,
  credentialHostOperations,
  deferred,
  projectId,
  projectWindowCapability,
} from "../App.test-fixtures";
import { ProjectCreateDialog } from "./ProjectCreateDialog";

describe("ProjectCreateDialog renderer flows", () => {
  function hostBridge(selectProjectRoot: OctantHostBridge["selectProjectRoot"]): OctantHostBridge {
    return {
      ...credentialHostOperations(),
      close: vi.fn(),
      maximizeOrRestore: vi.fn(),
      minimize: vi.fn(),
      projectWindowCapability,
      resetBounds: vi.fn(),
      selectProjectRoot,
      setSidebarMaterialPreference: vi.fn(),
      subscribeResolvedMaterial: vi.fn(() => () => undefined),
    };
  }

  it("creates Chat directly without invoking the native picker", async () => {
    const user = userEvent.setup();
    const bridge = hostBridge(vi.fn());
    const onCreate = vi.fn(async () => projectId);
    const onCreated = vi.fn();
    render(
      <ProjectCreateDialog
        hostBridge={bridge}
        mode="chat"
        onClose={vi.fn()}
        onCreate={onCreate}
        onCreated={onCreated}
      />,
    );

    await user.type(screen.getByLabelText("Project name"), "Research");
    await user.click(screen.getByRole("button", { name: "Create Project" }));

    expect(bridge.selectProjectRoot).not.toHaveBeenCalled();
    expect(onCreate).toHaveBeenCalledWith("chat", "Research", undefined);
    expect(onCreated).toHaveBeenCalledWith(projectId, "chat", "Research");
  });

  it("creates Work with only the native opaque receipt", async () => {
    const bridge = hostBridge(
      vi.fn(async () => ({
        kind: "selected" as const,
        receiptId: bindingReceipt,
        displayName: "Documents",
      })),
    );
    const onCreate = vi.fn(async () => projectId);
    render(
      <ProjectCreateDialog
        hostBridge={bridge}
        mode="work"
        onClose={vi.fn()}
        onCreate={onCreate}
        onCreated={vi.fn()}
      />,
    );

    await waitFor(() => expect(bridge.selectProjectRoot).toHaveBeenCalledWith("work"));
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith("work", "Documents", bindingReceipt));
    expect(screen.queryByLabelText("Project name")).toBeNull();
    expect(JSON.stringify(onCreate.mock.calls)).not.toContain("canonicalRoot");
  });

  it("redacts native picker rejection details", async () => {
    const bridge = hostBridge(
      vi.fn(async () => {
        throw new Error("/private/secret/path desktop-token");
      }),
    );
    const onCreate = vi.fn();
    render(
      <ProjectCreateDialog
        hostBridge={bridge}
        mode="code"
        onClose={vi.fn()}
        onCreate={onCreate}
        onCreated={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(screen.getByText("Project creation could not be completed.")).toBeVisible(),
    );
    expect(document.body).not.toHaveTextContent("/private/secret/path");
    expect(document.body).not.toHaveTextContent("desktop-token");
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("does not submit or open after unmount while the native picker is pending", async () => {
    const selection = deferred<{
      readonly kind: "selected";
      readonly receiptId: string;
      readonly displayName: string;
    }>();
    const bridge = hostBridge(vi.fn(() => selection.promise));
    const onCreate = vi.fn(async () => projectId);
    const onCreated = vi.fn();
    const view = render(
      <ProjectCreateDialog
        hostBridge={bridge}
        mode="code"
        onClose={vi.fn()}
        onCreate={onCreate}
        onCreated={onCreated}
      />,
    );
    await waitFor(() => expect(bridge.selectProjectRoot).toHaveBeenCalled());
    view.unmount();

    await act(async () =>
      selection.resolve({ kind: "selected", receiptId: bindingReceipt, displayName: "Documents" }),
    );
    expect(onCreate).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("keeps Cancel usable while creation is in flight and ignores the late result", async () => {
    const command = deferred<typeof projectId>();
    const bridge = hostBridge(
      vi.fn(async () => ({
        kind: "selected" as const,
        receiptId: bindingReceipt,
        displayName: "Documents",
      })),
    );
    const onClose = vi.fn();
    const onCreated = vi.fn();
    const view = render(
      <ProjectCreateDialog
        hostBridge={bridge}
        mode="code"
        onClose={onClose}
        onCreate={vi.fn(() => command.promise)}
        onCreated={onCreated}
      />,
    );
    await waitFor(() => expect(bridge.selectProjectRoot).toHaveBeenCalled());
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(cancel).toBeEnabled();
    expect(screen.getByRole("button", { name: "Close new Project" })).toBeEnabled();
    fireEvent.click(cancel);
    expect(onClose).toHaveBeenCalledOnce();
    view.unmount();
    await act(async () => command.resolve(projectId));
    expect(onCreated).not.toHaveBeenCalled();
  });
});
