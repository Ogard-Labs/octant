import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useSeesImages } from "./useSeesImages";

const scope = { projectId: "project-1", providerInstanceId: "provider-1", modelId: "luna" };

describe("a composer's image gate", () => {
  it("takes an image for a model that cannot read one once the host says Sees images can describe it", async () => {
    const seesImages = vi.fn(async () => ({
      kind: "available" as const,
      describedBy: { model: "Haiku 5.5", provider: "Anthropic" },
    }));
    const { result } = renderHook(() =>
      useSeesImages({ readsImages: false, ...scope, client: { seesImages } }),
    );
    expect(result.current.takesImages).toBe(false);
    await waitFor(() => expect(result.current.takesImages).toBe(true));
    expect(seesImages).toHaveBeenCalledWith(scope, expect.anything());
  });

  it("keeps refusing with the host's reason when Sees images cannot", async () => {
    const reason = "Luna can't read images. Set a model that sees images in Model roles.";
    const { result } = renderHook(() =>
      useSeesImages({
        readsImages: false,
        ...scope,
        client: { seesImages: async () => ({ kind: "refused" as const, reason }) },
      }),
    );
    await waitFor(() => expect(result.current.refusal).toBe(reason));
    expect(result.current.takesImages).toBe(false);
  });

  it("asks nothing for a model that reads images", () => {
    const seesImages = vi.fn();
    const { result } = renderHook(() =>
      useSeesImages({ readsImages: true, ...scope, client: { seesImages } }),
    );
    expect(result.current.takesImages).toBe(true);
    expect(seesImages).not.toHaveBeenCalled();
  });
});
