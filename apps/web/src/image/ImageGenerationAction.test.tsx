import { SplitWorkspace } from "../shell/SplitWorkspace";
import { splitCallbacks } from "../App.test-fixtures";
import { decodeWorkspaceLayoutNode } from "@octant/contracts/shell";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ImageGenerationClient } from "@octant/client-runtime/image-generation-client";
import type { ImageGenerationProfileView, ImageJob } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { ImageGenerationAction } from "./ImageGenerationAction";

const now = "2026-08-28T12:00:00.000Z";
const scopeId = "a3000000-0000-4000-8000-000000000002";

function profile(): ImageGenerationProfileView {
  return {
    instanceId: "a3000000-0000-4000-8000-000000000001" as ImageGenerationProfileView["instanceId"],
    displayName: "OpenAI Image",
    driverKind: "openai-image",
    modelAllowlist: ["gpt-image-2" as never],
    defaultModel: "gpt-image-2" as never,
  };
}

function queuedJob(): ImageJob {
  return {
    id: "a3000000-0000-4000-8000-000000000003" as ImageJob["id"],
    status: "queued",
    threadKind: "chat-thread",
    scopeId: scopeId as ImageJob["scopeId"],
    profileInstanceId: profile().instanceId,
    modelId: "gpt-image-2" as ImageJob["modelId"],
    promptHash: "a".repeat(64),
    artifacts: [],
    version: 1 as ImageJob["version"],
    createdAt: now as ImageJob["createdAt"],
    updatedAt: now as ImageJob["updatedAt"],
  };
}

describe("ImageGenerationAction", () => {
  it("opens image creation as workspace content instead of covering the conversation", async () => {
    const user = userEvent.setup();
    const client = {
      enqueue: vi.fn(),
      get: vi.fn(),
      cancel: vi.fn(),
    } as unknown as ImageGenerationClient;
    const layout = decodeWorkspaceLayoutNode({
      kind: "pane",
      nodeId: "00000000-0000-4000-8000-000000000611",
      paneId: "00000000-0000-4000-8000-000000000612",
      surface: {
        kind: "chat-thread",
        id: "00000000-0000-4000-8000-000000000613",
        mode: "chat",
        threadId: scopeId,
        title: "Conversation",
      },
    });
    render(
      <SplitWorkspace
        {...splitCallbacks()}
        layout={layout}
        renderSurface={() => (
          <>
            <p>Conversation content</p>
            <ImageGenerationAction
              client={client}
              profiles={[profile()]}
              scopeId={scopeId as never}
              threadKind="chat-thread"
            />
          </>
        )}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Create image" }));
    expect(screen.getByRole("heading", { name: "Create image" })).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Image prompt"), "A quiet forest");
    await user.click(screen.getByRole("tab", { name: "Conversation" }));
    expect(screen.getByText("Conversation content")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Create image" }));
    expect(screen.getAllByRole("tab", { name: "Create image" })).toHaveLength(1);
    expect(screen.getByLabelText("Image prompt")).toHaveValue("A quiet forest");
    await user.click(screen.getByRole("button", { name: "Close Create image" }));
    expect(screen.queryByRole("heading", { name: "Create image" })).not.toBeInTheDocument();
    expect(screen.getByText("Conversation content")).toBeVisible();
    expect(client.enqueue).not.toHaveBeenCalled();
  });

  it("does not offer an active Create image action without a client", () => {
    render(
      <ImageGenerationAction
        profiles={[profile()]}
        scopeId={scopeId as never}
        threadKind="chat-thread"
      />,
    );
    expect(screen.queryByRole("button", { name: /^Create image$/ })).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Create image unavailable. Open Settings to add an image profile.",
      }),
    ).toBeDisabled();
  });

  it("does not restore a stale poll after cancel starts", async () => {
    const user = userEvent.setup();
    let finishGet!: (job: ImageJob) => void;
    const get = vi.fn(
      () =>
        new Promise<ImageJob>((resolve) => {
          finishGet = resolve;
        }),
    );
    const cancel = vi.fn(async () => ({ ...queuedJob(), status: "cancelled" as const }));
    const client = {
      enqueue: vi.fn(async () => queuedJob()),
      get,
      cancel,
    } as unknown as ImageGenerationClient;
    render(
      <ImageGenerationAction
        client={client}
        profiles={[profile()]}
        scopeId={scopeId as never}
        threadKind="chat-thread"
      />,
    );
    await user.click(screen.getByRole("button", { name: "Create image" }));
    await user.type(screen.getByLabelText("Image prompt"), "a red cube");
    await user.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(client.enqueue).toHaveBeenCalled());
    await waitFor(() => expect(get).toHaveBeenCalled(), { timeout: 2000 });
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("Cancelled.")).toBeVisible();
    finishGet({ ...queuedJob(), status: "running" });
    await Promise.resolve();
    expect(screen.getByText("Cancelled.")).toBeVisible();
    expect(screen.queryByText("Generating…")).not.toBeInTheDocument();
    expect(screen.queryByText("Queued…")).not.toBeInTheDocument();
  });

  it("stops polling after unmount", async () => {
    const user = userEvent.setup();
    const get = vi.fn(async () => queuedJob());
    const client = {
      enqueue: vi.fn(async () => queuedJob()),
      get,
    } as unknown as ImageGenerationClient;
    const { unmount } = render(
      <ImageGenerationAction
        client={client}
        profiles={[profile()]}
        scopeId={scopeId as never}
        threadKind="chat-thread"
      />,
    );
    await user.click(screen.getByRole("button", { name: "Create image" }));
    await user.type(screen.getByLabelText("Image prompt"), "a red cube");
    await user.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(client.enqueue).toHaveBeenCalled());
    unmount();
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(get).not.toHaveBeenCalled();
  });
});
