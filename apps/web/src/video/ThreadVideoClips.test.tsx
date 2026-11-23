import { decodeVideoJob, type ImageGenerationScopeId, type VideoJob } from "@octant/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ThreadVideoClips, VideoClientContext } from "./ThreadVideoClips";

const scopeId = "f4000000-0000-4000-8000-000000000002" as ImageGenerationScopeId;

function job(status: VideoJob["status"], id: string): VideoJob {
  return decodeVideoJob({
    id,
    status,
    threadKind: "work-thread",
    scopeId,
    profileInstanceId: "f4000000-0000-4000-8000-000000000001",
    driverKind: "gemini-video",
    modelId: "gemini-omni-1.2-flash",
    promptHash: "a".repeat(64),
    options: { durationSeconds: 10, resolution: "720p", aspectRatio: "16:9", audio: true },
    imageCount: 0,
    estimatedCostUsdMicros: 695_040,
    ...(status === "completed"
      ? {
          clip: {
            clipId: "f4000000-0000-4000-8000-000000000009",
            hash: "b".repeat(64),
            size: 2048,
            durationSeconds: 10,
            resolution: "720p",
            aspectRatio: "16:9",
          },
        }
      : {}),
    providerCopy: status === "completed" ? "removed" : "held",
    version: 2,
    createdAt: "2026-11-22T12:00:00.000Z",
    updatedAt: "2026-11-22T12:00:00.000Z",
  });
}

describe("ThreadVideoClips", () => {
  it("plays a finished clip on demand from its ticket and lets the person stop a running one", async () => {
    const finished = job("completed", "f4000000-0000-4000-8000-000000000003");
    const running = job("running", "f4000000-0000-4000-8000-000000000004");
    const stop = vi.fn(async () => running);
    const client = {
      list: vi.fn(async () => ({ jobs: [finished, running] })),
      clipUrl: vi.fn(async () => ({
        url: "http://127.0.0.1:3100/api/video/clip?ticket=t",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      })),
      stop,
    };
    const { container } = render(
      <VideoClientContext.Provider value={client}>
        <ThreadVideoClips scopeId={scopeId} threadKind="work-thread" />
      </VideoClientContext.Provider>,
    );
    await waitFor(() => expect(container.querySelector("video")).not.toBeNull());
    const video = container.querySelector("video");
    expect(video?.getAttribute("src")).toBe("http://127.0.0.1:3100/api/video/clip?ticket=t");
    expect(video?.getAttribute("preload")).toBe("metadata");
    expect(video?.hasAttribute("autoplay")).toBe(false);
    expect(video?.hasAttribute("controls")).toBe(true);
    expect(client.clipUrl).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(stop).toHaveBeenCalledWith(running.id);
  });

  it("downloads a clip through a same-origin blob the way the image card does", async () => {
    const finished = job("completed", "f4000000-0000-4000-8000-000000000003");
    const client = {
      list: vi.fn(async () => ({ jobs: [finished] })),
      clipUrl: vi.fn(async () => ({
        url: "http://127.0.0.1:3100/api/video/clip?ticket=t",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      })),
    };
    const blob = new Blob(["clip-bytes"], { type: "video/mp4" });
    const clipFetch = vi.fn(async () => new Response(blob));
    const createObjectURL = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:http://localhost/clip");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    vi.stubGlobal("fetch", clipFetch);
    try {
      render(
        <VideoClientContext.Provider value={client}>
          <ThreadVideoClips scopeId={scopeId} threadKind="work-thread" />
        </VideoClientContext.Provider>,
      );
      await waitFor(() =>
        expect(screen.getByRole("link", { name: "Download" })).toBeInTheDocument(),
      );
      await userEvent.click(screen.getByRole("link", { name: "Download" }));
      await waitFor(() => expect(anchorClick).toHaveBeenCalled());
      expect(clipFetch).toHaveBeenCalledWith(
        "http://127.0.0.1:3100/api/video/clip?ticket=t",
      );
      expect(createObjectURL).toHaveBeenCalledWith(blob);
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:http://localhost/clip");
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("revokes a blob clip that resolves after the card unmounts", async () => {
    const finished = job("completed", "f4000000-0000-4000-8000-000000000003");
    let resolveTicket: (ticket: { url: string; expiresAt: string }) => void = () => undefined;
    const ticketReady = new Promise<{ url: string; expiresAt: string }>((resolve) => {
      resolveTicket = resolve;
    });
    const client = {
      list: vi.fn(async () => ({ jobs: [finished] })),
      clipUrl: vi.fn(async () => ticketReady),
    };
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    try {
      const view = render(
        <VideoClientContext.Provider value={client}>
          <ThreadVideoClips scopeId={scopeId} threadKind="work-thread" />
        </VideoClientContext.Provider>,
      );
      await waitFor(() => expect(client.clipUrl).toHaveBeenCalled());
      view.unmount();
      resolveTicket({ url: "blob:http://localhost/late", expiresAt: "2027-01-01T00:00:00Z" });
      await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith("blob:http://localhost/late"));
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("shows nothing for a thread with no clips", async () => {
    const client = { list: vi.fn(async () => ({ jobs: [] })), clipUrl: vi.fn() };
    const { container } = render(
      <VideoClientContext.Provider value={client}>
        <ThreadVideoClips scopeId={scopeId} threadKind="work-thread" />
      </VideoClientContext.Provider>,
    );
    await waitFor(() => expect(client.list).toHaveBeenCalled());
    expect(container.querySelector("section")).toBeNull();
  });
});
