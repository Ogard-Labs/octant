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
