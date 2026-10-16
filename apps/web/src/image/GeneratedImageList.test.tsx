import { WorkspaceContentViewContext } from "../shell/WorkspaceContentView";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ImageArtifactRecord, ImageGenerationProfileView, ImageJob } from "@octant/contracts";
import type { ImageGenerationClient } from "@octant/client-runtime/image-generation-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GeneratedImageList } from "./GeneratedImageList";
import { ImageJobChangeRevisionContext } from "./ImageJobChangeRevision";

const scopeId = "a3000000-0000-4000-8000-000000000002" as never;
const nextScopeId = "a3000000-0000-4000-8000-000000000003" as never;

function queuedJob(jobScopeId: typeof scopeId): ImageJob {
  return {
    id: "a3000000-0000-4000-8000-000000000004" as never,
    status: "queued",
    threadKind: "chat-thread",
    scopeId: jobScopeId,
    profileInstanceId: "a3000000-0000-4000-8000-000000000005" as never,
    modelId: "image-model" as never,
    promptHash: "a".repeat(64),
    artifacts: [],
    version: 1 as never,
    createdAt: "2026-08-31T00:00:00.000Z" as never,
    updatedAt: "2026-08-31T00:00:00.000Z" as never,
  };
}

function profile(): ImageGenerationProfileView {
  return {
    instanceId: "a3000000-0000-4000-8000-000000000005" as ImageGenerationProfileView["instanceId"],
    displayName: "OpenAI Image",
    driverKind: "openai-image",
    modelAllowlist: ["gpt-image-2" as never],
    defaultModel: "gpt-image-2" as never,
  };
}

function completedJob(): ImageJob {
  return {
    ...queuedJob(scopeId),
    status: "completed",
    artifacts: [
      {
        attachmentId: "a3000000-0000-4000-8000-000000000006",
        hash: "b".repeat(64),
        size: 128,
        mime: "image/png",
        evidence: {
          profileInstanceId: profile().instanceId,
          modelId: "gpt-image-2",
          promptHash: "a".repeat(64),
          jobId: "a3000000-0000-4000-8000-000000000004",
        },
      } as unknown as ImageArtifactRecord,
    ],
  };
}

describe("GeneratedImageList polling", () => {
  afterEach(() => vi.useRealTimers());

  it("does not overlap a slow generated-image list request", async () => {
    vi.useFakeTimers();
    let resolveFirst: ((value: { readonly jobs: [] }) => void) | undefined;
    const list = vi.fn(
      () =>
        new Promise<{ readonly jobs: [] }>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const client = { list } as unknown as ImageGenerationClient;
    render(
      <GeneratedImageList
        client={client}
        profiles={[]}
        scopeId={scopeId}
        threadKind="chat-thread"
      />,
    );

    expect(list).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(8_000));
    expect(list).toHaveBeenCalledTimes(1);

    await act(async () => resolveFirst?.({ jobs: [] }));
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("clears the previous scope and starts the next generation while an old poll is pending", async () => {
    vi.useFakeTimers();
    let resolveInitial: ((value: { readonly jobs: ReadonlyArray<ImageJob> }) => void) | undefined;
    let resolveOldPoll: ((value: { readonly jobs: ReadonlyArray<ImageJob> }) => void) | undefined;
    let resolveNextScope: ((value: { readonly jobs: ReadonlyArray<ImageJob> }) => void) | undefined;
    const list = vi.fn(
      ({
        scopeId: requestedScopeId,
        threadKind: requestedThreadKind,
      }: {
        readonly scopeId: unknown;
        readonly threadKind: string;
      }) => {
        if (
          requestedScopeId === scopeId &&
          requestedThreadKind === "chat-thread" &&
          list.mock.calls.length === 1
        ) {
          return new Promise<{ readonly jobs: ReadonlyArray<ImageJob> }>((resolve) => {
            resolveInitial = resolve;
          });
        }
        if (requestedScopeId === scopeId && requestedThreadKind === "chat-thread") {
          return new Promise<{ readonly jobs: ReadonlyArray<ImageJob> }>((resolve) => {
            resolveOldPoll = resolve;
          });
        }
        return new Promise<{ readonly jobs: ReadonlyArray<ImageJob> }>((resolve) => {
          resolveNextScope = resolve;
        });
      },
    );
    const client = { list } as unknown as ImageGenerationClient;
    const view = render(
      <GeneratedImageList
        client={client}
        profiles={[]}
        scopeId={scopeId}
        threadKind="chat-thread"
      />,
    );

    await act(async () => resolveInitial?.({ jobs: [queuedJob(scopeId)] }));
    expect(screen.getByText("Image queued…")).toBeInTheDocument();

    await act(async () => vi.advanceTimersByTimeAsync(750));
    expect(list).toHaveBeenCalledTimes(2);

    view.rerender(
      <GeneratedImageList
        client={client}
        profiles={[]}
        scopeId={nextScopeId}
        threadKind="code-thread"
      />,
    );
    expect(list).toHaveBeenCalledTimes(3);
    expect(screen.queryByText("Image queued…")).not.toBeInTheDocument();

    await act(async () => resolveOldPoll?.({ jobs: [queuedJob(scopeId)] }));
    expect(screen.queryByText("Image queued…")).not.toBeInTheDocument();

    await act(async () => resolveNextScope?.({ jobs: [queuedJob(nextScopeId)] }));
    expect(screen.getByText("Image queued…")).toBeInTheDocument();
  });

  it("keeps background list failures out of the transcript and retries in a new scope", async () => {
    const list = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockReturnValueOnce(new Promise(() => undefined));
    const client = { list } as unknown as ImageGenerationClient;
    const view = render(
      <GeneratedImageList
        client={client}
        profiles={[]}
        scopeId={scopeId}
        threadKind="chat-thread"
      />,
    );

    await act(async () => undefined);
    expect(screen.queryByText("Generated images are unavailable.")).not.toBeInTheDocument();
    expect(screen.queryByTestId("generated-image-list-error")).not.toBeInTheDocument();
    view.rerender(
      <GeneratedImageList
        client={client}
        profiles={[]}
        scopeId={nextScopeId}
        threadKind="code-thread"
      />,
    );

    expect(list).toHaveBeenCalledTimes(2);
  });

  it("opens an image revision beside the conversation with its own artifact identity", async () => {
    const user = userEvent.setup();
    const open = vi.fn();
    const job = completedJob();
    const client = {
      list: vi.fn(async () => ({ jobs: [job] })),
      artifact: vi.fn(async () => new Blob(["png"], { type: "image/png" })),
    } as unknown as ImageGenerationClient;
    render(
      <WorkspaceContentViewContext.Provider value={{ open }}>
        <GeneratedImageList
          client={client}
          profiles={[profile()]}
          scopeId={scopeId}
          threadKind="chat-thread"
        />
      </WorkspaceContentViewContext.Provider>,
    );
    await user.click(await screen.findByRole("button", { name: "Revise" }));
    expect(open).toHaveBeenCalledWith(
      `image-generation:chat-thread:${scopeId}:${job.artifacts[0]?.attachmentId}`,
      "Revise image",
      expect.any(Function),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows a revision the moment it is enqueued instead of after the idle cadence", async () => {
    const user = userEvent.setup();
    const list = vi
      .fn()
      .mockResolvedValueOnce({ jobs: [completedJob()] })
      .mockResolvedValue({ jobs: [completedJob(), queuedJob(scopeId)] });
    const client = {
      list,
      enqueue: vi.fn(async () => queuedJob(scopeId)),
      artifact: vi.fn(async () => new Blob(["png"], { type: "image/png" })),
    } as unknown as ImageGenerationClient;
    render(
      <GeneratedImageList
        client={client}
        profiles={[profile()]}
        scopeId={scopeId}
        threadKind="chat-thread"
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Revise" }));
    await user.type(screen.getByLabelText("Image prompt"), "make it blue");
    await user.click(screen.getByRole("button", { name: "Generate" }));

    await waitFor(() => expect(client.enqueue).toHaveBeenCalledOnce());
    // Without its own re-read the queued revision stays hidden for the whole
    // thirty-second idle interval.
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });
});

describe("generated image preview read", () => {
  afterEach(() => vi.restoreAllMocks());

  it("stops reading an image when its card goes away instead of finishing unobserved", async () => {
    const readers: FileReader[] = [];
    const readAsDataURL = FileReader.prototype.readAsDataURL;
    vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(function (
      this: FileReader,
      blob: Blob,
    ) {
      readers.push(this);
      readAsDataURL.call(this, blob);
    });
    const client = {
      list: vi.fn(async () => ({ jobs: [completedJob()] })),
      artifact: vi.fn(async () => new Blob(["png"], { type: "image/png" })),
    } as unknown as ImageGenerationClient;
    const view = render(
      <GeneratedImageList
        client={client}
        profiles={[profile()]}
        scopeId={scopeId}
        threadKind="chat-thread"
      />,
    );
    await waitFor(() => expect(readers).toHaveLength(1));

    view.unmount();
    await new Promise((resolve) => setTimeout(resolve, 20));

    // A read left running would have produced the data URL by now, and would
    // still be running when the test file's environment is torn down.
    expect(readers[0]?.result).toBeNull();
  });
});

describe("generated image arrival", () => {
  it("shows an image the moment the host reports its job finished, without waiting for the idle read", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({ jobs: [] })
      .mockResolvedValue({ jobs: [completedJob()] });
    const client = {
      list,
      artifact: vi.fn(async () => new Blob(["png"], { type: "image/png" })),
    } as unknown as ImageGenerationClient;
    const tree = (revision: number) => (
      <ImageJobChangeRevisionContext.Provider value={revision}>
        <GeneratedImageList
          client={client}
          profiles={[profile()]}
          scopeId={scopeId}
          threadKind="chat-thread"
        />
      </ImageJobChangeRevisionContext.Provider>
    );
    const view = render(tree(0));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("generated-image-card")).not.toBeInTheDocument();

    view.rerender(tree(1));

    expect(await screen.findByTestId("generated-image-card")).toBeVisible();
    expect(list).toHaveBeenCalledTimes(2);
  });
});

describe("generated image arrival during a read", () => {
  it("reads again after the in-flight read when a job finishes while it is running", async () => {
    let settleFirst: ((value: { readonly jobs: ReadonlyArray<ImageJob> }) => void) | undefined;
    const list = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<{ readonly jobs: ReadonlyArray<ImageJob> }>((resolve) => {
            settleFirst = resolve;
          }),
      )
      .mockResolvedValue({ jobs: [completedJob()] });
    const client = {
      list,
      artifact: vi.fn(async () => new Blob(["png"], { type: "image/png" })),
    } as unknown as ImageGenerationClient;
    const tree = (revision: number) => (
      <ImageJobChangeRevisionContext.Provider value={revision}>
        <GeneratedImageList
          client={client}
          profiles={[profile()]}
          scopeId={scopeId}
          threadKind="chat-thread"
        />
      </ImageJobChangeRevisionContext.Provider>
    );
    const view = render(tree(0));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));

    // The job finishes after the host answered this read's snapshot but
    // before the read settles: the stale answer must not be the last word.
    view.rerender(tree(1));
    expect(list).toHaveBeenCalledTimes(1);
    await act(async () => settleFirst?.({ jobs: [] }));

    expect(await screen.findByTestId("generated-image-card")).toBeVisible();
    expect(list).toHaveBeenCalledTimes(2);
  });
});

describe("generated image attribution", () => {
  it("names the custom source a job ran on, not every source on its provider", async () => {
    const shared = {
      ...profile(),
      displayName: "Local images",
      driverKind: "openai-compatible-image" as const,
      modelAllowlist: ["image-small" as never, "image-large" as never],
      defaultModel: "image-small" as never,
      sourceLabels: [
        { modelId: "image-small" as never, label: "Fake small" },
        { modelId: "image-large" as never, label: "Fake large" },
      ],
    } satisfies ImageGenerationProfileView;
    const job = { ...completedJob(), modelId: "image-large" as never };
    const client = {
      list: vi.fn(async () => ({ jobs: [job] })),
      artifact: vi.fn(async () => new Blob(["png"], { type: "image/png" })),
    } as unknown as ImageGenerationClient;
    render(
      <GeneratedImageList
        client={client}
        profiles={[shared]}
        scopeId={scopeId}
        threadKind="chat-thread"
      />,
    );

    expect(await screen.findByTestId("generated-image-attribution")).toHaveTextContent(
      "Fake large · image-large",
    );
  });
});
