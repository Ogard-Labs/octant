import type { PullRequestReviewClient } from "@octant/client-runtime";
import type { PullRequestGuideClient } from "@octant/client-runtime/pull-request-guide-client";
import {
  GithubRepositoryName,
  GithubRepositoryOwner,
  decodeProjectId,
  type PullRequestReviewTarget,
} from "@octant/contracts";
import {
  decodePullRequestGuideView,
  type PullRequestGuideView,
  type PullRequestViewedView,
} from "@octant/contracts/pull-request-guide";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import PullRequestGuideTab from "./PullRequestGuideTab";
import PullRequestViewedFiles from "./PullRequestViewedFiles";

const TARGET: PullRequestReviewTarget = {
  projectId: decodeProjectId("10000000-0000-4000-8000-000000000001"),
  repositoryOwner: Schema.decodeUnknownSync(GithubRepositoryOwner)("octant"),
  repositoryName: Schema.decodeUnknownSync(GithubRepositoryName)("octant"),
  number: 12,
};
const OLD_HEAD = "a".repeat(40);
const NEW_HEAD = "b".repeat(40);

function guideView(headShown: string): PullRequestGuideView {
  return decodePullRequestGuideView({
    guide: {
      guideId: "80000000-0000-4000-8000-000000000001",
      headSha: OLD_HEAD,
      providerInstanceId: "60000000-0000-4000-8000-000000000002",
      modelId: "guide-model",
      recordedAt: "2026-11-26T12:00:00.000Z",
      stops: [
        {
          id: "stop-1",
          title: "Refresh starts here",
          why: "The loop now stops after one pass.",
          needsDecision: true,
          anchors: [{ path: "src/refresh.ts", startLine: 10, endLine: 12 }],
        },
        { id: "stop-2", title: "Tests", why: "", needsDecision: false, anchors: [] },
      ],
    },
    stale: headShown !== OLD_HEAD,
    running: false,
    modelPicked: true,
  });
}

/** A host that answers the guide routes from the given handlers; nothing leaves the test. */
function fakeClient(guides: Partial<PullRequestGuideClient>): PullRequestReviewClient {
  const routes: PullRequestGuideClient = {
    read: async ({ headSha }) => guideView(headSha ?? OLD_HEAD),
    write: async () => guideView(OLD_HEAD),
    readViewed: async () => ({ files: [] }),
    setViewed: async () => undefined,
    ...guides,
  };
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname.replace("/api/code/pull-request-guides", "");
    const body = JSON.parse(String(init?.body ?? "{}"));
    const answer =
      path === "/query"
        ? await routes.read(body)
        : path === "/write"
          ? await routes.write(body.target)
          : path === "/viewed/query"
            ? await routes.readViewed(body.target)
            : await routes.setViewed(body).then(() => ({ status: "done" }));
    return new Response(JSON.stringify(answer), { status: 200 });
  };
  const client: Pick<PullRequestReviewClient, "transport"> = {
    transport: {
      baseUrl: "http://127.0.0.1:4100",
      fetch: fetch as typeof globalThis.fetch,
      windowCapability: "test",
    },
  };
  return client as PullRequestReviewClient;
}

describe("the pull request Guide tab", () => {
  it("renders a guide's stops with anchors and marks itself stale after a push", async () => {
    const onOpenAnchor = vi.fn();
    const write = vi.fn(async () => ({ ...guideView(NEW_HEAD), running: true }));
    const client = fakeClient({ write });
    const { rerender } = render(
      <PullRequestGuideTab
        client={client}
        headSha={OLD_HEAD}
        onOpenAnchor={onOpenAnchor}
        target={TARGET}
      />,
    );
    expect(await screen.findByText("Refresh starts here")).toBeTruthy();
    expect(screen.getByText("Needs your decision")).toBeTruthy();
    expect(screen.getByText("Not anchored to the diff.")).toBeTruthy();
    expect(screen.queryByText("Written for an older push.")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "src/refresh.ts:10–12" }));
    expect(onOpenAnchor).toHaveBeenCalledWith({
      path: "src/refresh.ts",
      startLine: 10,
      endLine: 12,
    });

    // J steps to the next stop.
    await userEvent.keyboard("j");
    const second = screen.getByText("Tests").closest("li");
    expect(second?.getAttribute("aria-current")).toBe("step");

    rerender(
      <PullRequestGuideTab
        client={client}
        headSha={NEW_HEAD}
        onOpenAnchor={onOpenAnchor}
        target={TARGET}
      />,
    );
    const banner = await screen.findByText("Written for an older push.");
    await userEvent.click(
      within(banner.closest(".callout") ?? document.body).getByRole("button", { name: "Rewrite" }),
    );
    expect(write).toHaveBeenCalledWith(TARGET);
  });

  it("asks for a guide model before anything runs", async () => {
    const client = fakeClient({
      read: async () =>
        decodePullRequestGuideView({ stale: false, running: false, modelPicked: false }),
    });
    render(
      <PullRequestGuideTab
        client={client}
        headSha={OLD_HEAD}
        onOpenAnchor={vi.fn()}
        target={TARGET}
      />,
    );
    expect(await screen.findByText(/Pick a model to write guides/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Write guide" })).toBeNull();
  });

  it("offers no Write guide or Rewrite on a closed or merged pull request", async () => {
    const client = fakeClient({});
    render(
      <PullRequestGuideTab
        client={client}
        headSha={NEW_HEAD}
        onOpenAnchor={vi.fn()}
        target={TARGET}
        writable={false}
      />,
    );
    expect(
      await screen.findByText("Guides are written while a pull request is open."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Rewrite" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Write guide" })).toBeNull();
  });
});

describe("Viewed files", () => {
  it("counts viewed files, shows Changed for a file GitHub dismissed, and marks one on GitHub", async () => {
    const setViewed = vi.fn(async () => undefined);
    const viewed: PullRequestViewedView = {
      files: [
        { path: "src/refresh.ts" as never, state: "viewed" },
        { path: "src/session.ts" as never, state: "changed" },
      ],
    };
    render(
      <PullRequestViewedFiles
        client={fakeClient({ readViewed: async () => viewed, setViewed })}
        files={[
          { path: "src/refresh.ts", additions: 2, deletions: 1 },
          { path: "src/session.ts", additions: 4, deletions: 0 },
          { path: "README.md", additions: 1, deletions: 0 },
        ]}
        target={TARGET}
      />,
    );
    expect(await screen.findByText("1 of 3 viewed")).toBeTruthy();
    expect(screen.getByText("Changed")).toBeTruthy();
    await userEvent.click(screen.getByRole("checkbox", { name: "Viewed README.md" }));
    await waitFor(() => expect(screen.getByText("2 of 3 viewed")).toBeTruthy());
    expect(setViewed).toHaveBeenCalledWith({ target: TARGET, path: "README.md", viewed: true });
  });
});
