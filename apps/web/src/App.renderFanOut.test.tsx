import type { CodeClient } from "@octant/client-runtime/code-client";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Profiler, createElement, type ComponentType } from "react";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App";
import {
  chats,
  client,
  codeShellBootstrap,
  codes,
  codeThreadId,
  deferred,
  projectWindowCapability,
  projects,
  providers,
  windowId,
} from "./App.test-fixtures";

/**
 * Commits per surface, counted by a `Profiler` wrapped around each surface's
 * module export. A surface that re-rendered in a commit counts once for that
 * commit; a surface whose container bailed out does not appear in it. A
 * Profiler also fires for its descendants, so the pane region (which holds
 * the transcript) counts the transcript's commits, while the pane header and
 * the dock's open tool are siblings of it and count only their own.
 */
const commits = vi.hoisted(() => ({
  shell: 0,
  sidebar: 0,
  chrome: 0,
  readers: 0,
  threadPane: 0,
  paneHeader: 0,
  transcript: 0,
  dock: 0,
  dockTool: 0,
}));

type Region = keyof typeof commits;

function profiled<P extends object>(Surface: ComponentType<P>, region: Region): ComponentType<P> {
  return function ProfiledSurface(props: P) {
    return createElement(
      Profiler,
      {
        id: region,
        onRender: () => {
          commits[region] += 1;
        },
      },
      createElement(Surface, props),
    );
  };
}

vi.mock("./shell/ShellSidebar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shell/ShellSidebar")>();
  return { ...actual, ShellSidebar: profiled(actual.ShellSidebar, "sidebar") };
});
vi.mock("./shell/WindowChrome", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shell/WindowChrome")>();
  return { ...actual, WindowChrome: profiled(actual.WindowChrome, "chrome") };
});
vi.mock("./shell/WorkspaceRailLayers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shell/WorkspaceRailLayers")>();
  return {
    ...actual,
    WorkspaceRailLayers: profiled(actual.WorkspaceRailLayers, "readers"),
  };
});
vi.mock("./shell/WorkspaceView", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shell/WorkspaceView")>();
  return { ...actual, WorkspaceView: profiled(actual.WorkspaceView, "threadPane") };
});
vi.mock("./code/CodeThreadWorkspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./code/CodeThreadWorkspace")>();
  return {
    ...actual,
    CodeThreadWorkspace: profiled(actual.CodeThreadWorkspace, "transcript"),
  };
});
vi.mock("./shell/RightUtilityDock", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shell/RightUtilityDock")>();
  return { ...actual, RightUtilityDock: profiled(actual.RightUtilityDock, "dock") };
});
vi.mock("./shell/EnvironmentMark", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shell/EnvironmentMark")>();
  return { ...actual, EnvironmentMark: profiled(actual.EnvironmentMark, "paneHeader") };
});
vi.mock("./dockModules/EnvironmentModule", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./dockModules/EnvironmentModule")>();
  return { ...actual, default: profiled(actual.default, "dockTool") };
});

const STREAMED_EVENTS = 8;

/**
 * A Code client whose thread stream holds `STREAMED_EVENTS` thread updates
 * until released, then delivers them as one burst. Each accepted frame makes
 * the thread's controller re-read the thread and its conversation, which is
 * the fan-out a streaming turn produces in the shell.
 */
function streamingCodes() {
  const base = codes();
  const release = deferred<void>();
  let lastSequence = 0;
  let subscriptions = 0;
  async function* idle(signal: AbortSignal): AsyncGenerator<never> {
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }
  async function* burst(signal: AbortSignal) {
    const listed = (await base.bootstrap()).threads[0];
    if (listed === undefined) throw new Error("The Code fixture listed no thread.");
    await release.promise;
    for (let sequence = 1; sequence <= STREAMED_EVENTS; sequence += 1) {
      // One task per event, as a host delivers them, so React commits each
      // event on its own instead of folding the burst into one render.
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (signal.aborted) return;
      lastSequence = sequence;
      yield {
        threadId: codeThreadId,
        sequence,
        event: {
          kind: "thread-updated",
          thread: { ...listed, version: sequence + 1, title: `Controller foundation ${sequence}` },
        },
      } as never;
    }
    yield* idle(signal);
  }
  const api: CodeClient = {
    ...base,
    subscribe: vi.fn((_threadId, _cursor, signal: AbortSignal) => {
      subscriptions += 1;
      return subscriptions === 1 ? burst(signal) : idle(signal);
    }) as never,
    thread: vi.fn(async () => {
      const view = (await base.thread(codeThreadId)) as { readonly thread: unknown };
      return { ...view, lastSequence } as never;
    }),
  };
  return { api, release };
}

function snapshot(): Record<Region, number> {
  return { ...commits };
}

function perEvent(before: Record<Region, number>, after: Record<Region, number>) {
  const out: Record<string, number> = {};
  for (const region of Object.keys(commits) as ReadonlyArray<Region>) {
    out[region] = (after[region] - before[region]) / STREAMED_EVENTS;
  }
  return out;
}

describe("render fan-out of a streaming Code turn", () => {
  it("commits only the transcript for a streamed event: not the sidebar, chrome, readers, pane header, dock or its open tool", async () => {
    const { api, release } = streamingCodes();
    render(
      <Profiler
        id="shell"
        onRender={() => {
          commits.shell += 1;
        }}
      >
        <App
          chatClient={chats()}
          codeClient={api}
          isNarrow={false}
          launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
          projectClient={projects()}
          projectWindowCapability={projectWindowCapability}
          providerClient={providers()}
          shellClient={client(codeShellBootstrap())}
        />
      </Profiler>,
    );
    // The Code surface is a lazy chunk whose first load takes about a second here.
    expect(
      await screen.findByRole("region", { name: "Code thread" }, { timeout: 5000 }),
    ).toBeVisible();
    expect(
      await screen.findByRole("complementary", { name: "Right Utility Dock" }, { timeout: 5000 }),
    ).toBeVisible();
    // A tool that reads nothing of the thread, open in the dock: the dock
    // follows the thread only while a tool that shows the turn is open.
    const dock = screen.getByRole("complementary", { name: "Right Utility Dock" });
    await userEvent.click(
      within(within(dock).getByRole("group", { name: "Quick tools" })).getByRole("button", {
        name: "Open Environment",
      }),
    );
    await waitFor(() =>
      expect(document.querySelector("[data-octant-environment-dock]")).not.toBeNull(),
    );
    await waitFor(() => expect(api.subscribe).toHaveBeenCalled());
    await waitFor(() => expect(api.conversation).toHaveBeenCalled());
    // Let the first load's own reads land before the burst is measured.
    await act(() => new Promise((resolve) => setTimeout(resolve, 150)));
    const threadReadsBefore = vi.mocked(api.thread).mock.calls.length;
    const before = snapshot();

    release.resolve();
    await waitFor(() =>
      expect(vi.mocked(api.thread).mock.calls.length).toBeGreaterThanOrEqual(
        threadReadsBefore + STREAMED_EVENTS,
      ),
    );
    // The last frame's thread read is followed by its conversation read and
    // follow-up read; a short settle lets those commits land before counting.
    await act(() => new Promise((resolve) => setTimeout(resolve, 150)));
    const after = snapshot();
    const fanOut = perEvent(before, after);
    console.info(`render fan-out per streamed event: ${JSON.stringify(fanOut)}`);

    expect(fanOut.shell).toBeGreaterThan(0);
    expect(fanOut.transcript).toBeGreaterThan(0);
    expect(fanOut.sidebar).toBe(0);
    expect(fanOut.chrome).toBe(0);
    expect(fanOut.readers).toBe(0);
    expect(fanOut.paneHeader).toBe(0);
    // The pane region holds the transcript, so a Profiler around it fires with
    // every transcript commit; the pane itself adds no commit of its own.
    expect(fanOut.threadPane).toBe(fanOut.transcript);
    expect(fanOut.dock).toBe(0);
    expect(fanOut.dockTool).toBe(0);
  });
});
