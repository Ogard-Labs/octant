import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ImageGenerationClient } from "@octant/client-runtime/image-generation-client";
import { IMAGE_LIBRARY_SCOPE_ID, type ImageGenerationProfileView } from "@octant/contracts";
import { ImageLibraryView } from "./ImageLibraryView";

function client(): ImageGenerationClient {
  return {
    profiles: vi.fn(async () => ({ profiles: [] })),
    list: vi.fn(async () => ({ jobs: [] })),
    enqueue: vi.fn(),
    get: vi.fn(),
    cancel: vi.fn(),
    artifact: vi.fn(),
    save: vi.fn(),
  } as unknown as ImageGenerationClient;
}

const profile = {
  instanceId: "40000000-0000-4000-8000-000000000001",
  displayName: "OpenAI images",
  kind: "openai-image",
  models: [{ id: "gpt-image-1", displayName: "GPT Image" }],
} as unknown as ImageGenerationProfileView;

describe("ImageLibraryView", () => {
  it("lists the host-wide library and offers a new image once a profile exists", async () => {
    const api = client();
    render(<ImageLibraryView client={api} profiles={[profile]} />);

    expect(screen.getByRole("region", { name: "Image generator" })).toBeVisible();
    expect(screen.getByRole("button", { name: /Create image/ })).toBeVisible();
    await waitFor(() => expect(api.list).toHaveBeenCalled());
    expect(api.list).toHaveBeenCalledWith(
      expect.objectContaining({ threadKind: "image-library", scopeId: IMAGE_LIBRARY_SCOPE_ID }),
    );
  });

  it("points at Providers when no image profile is configured", () => {
    const onOpenSettings = vi.fn();
    render(<ImageLibraryView client={client()} onOpenSettings={onOpenSettings} profiles={[]} />);

    expect(screen.getByRole("status")).toHaveTextContent("No image profile is configured.");
    expect(screen.getByRole("button", { name: "Add an image profile" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Create image/ })).not.toBeInTheDocument();
  });
});
