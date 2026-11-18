import type { BrowserWindow, WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import { createDesktopFilesClose, shouldPreflightNativeQuit } from "./desktopFilesClose";
import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";

type NavigationListener = (
  event: unknown,
  url: string,
  isInPlace: boolean,
  isMainFrame: boolean,
) => void;

function fakeWindow() {
  let destroyed = false;
  const navigation: NavigationListener[] = [];
  const onceHandlers = new Map<string, () => void>();
  const contents = {
    isDestroyed: () => destroyed,
    send: vi.fn(),
    on: vi.fn((channel: string, listener: NavigationListener) => {
      if (channel === "did-start-navigation") navigation.push(listener);
      else onceHandlers.set(channel, listener as () => void);
    }),
    once: vi.fn((channel: string, listener: () => void) => {
      onceHandlers.set(channel, listener);
    }),
  } as unknown as WebContents;
  const window = {
    isDestroyed: () => destroyed,
    isMinimized: () => false,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    webContents: contents,
    once: vi.fn((channel: string, listener: () => void) => {
      onceHandlers.set(channel, listener);
    }),
    emitNavigation: (isInPlace = false, isMainFrame = true) => {
      for (const listener of navigation) listener({}, "https://example", isInPlace, isMainFrame);
    },
    emitRendererGone: () => onceHandlers.get("render-process-gone")?.(),
    emitClosed: () => {
      destroyed = true;
      onceHandlers.get("closed")?.();
    },
  } as unknown as BrowserWindow & {
    emitNavigation: (isInPlace?: boolean, isMainFrame?: boolean) => void;
    emitRendererGone: () => void;
    emitClosed: () => void;
  };
  return window;
}

function sentChecks(window: BrowserWindow): Array<Record<string, unknown>> {
  return vi
    .mocked(window.webContents.send)
    .mock.calls.filter(
      ([channel, payload]) =>
        channel === DESKTOP_IPC_CHANNELS.filesCloseRequest &&
        (payload as { kind?: string }).kind === "check",
    )
    .map(([, payload]) => payload as Record<string, unknown>);
}

describe("desktopFilesClose", () => {
  it("asks for the acknowledgement before waiting on the person's answer", async () => {
    const filesClose = createDesktopFilesClose();
    const window = fakeWindow();
    filesClose.install(window);
    const outcome = filesClose.prepare(window);
    const request = sentChecks(window)[0];
    expect(request).toBeDefined();
    // An allow before the renderer acknowledged is ignored.
    filesClose.reply(window, { requestId: request?.requestId, answer: "allow" });
    filesClose.reply(window, { requestId: request?.requestId, answer: "checking" });
    filesClose.reply(window, { requestId: request?.requestId, answer: "allow" });
    expect(await outcome).toBe(true);
    expect(filesClose.holds(window)).toBe(true);
    filesClose.release(window);
    expect(filesClose.holds(window)).toBe(false);
    expect(window.webContents.send).toHaveBeenLastCalledWith(
      DESKTOP_IPC_CHANNELS.filesCloseRequest,
      {
        requestId: request?.requestId,
        kind: "release",
      },
    );
  });

  it("ignores replies from the wrong window or with the wrong request id", async () => {
    const filesClose = createDesktopFilesClose();
    const first = fakeWindow();
    const second = fakeWindow();
    filesClose.install(first);
    filesClose.install(second);
    const outcome = filesClose.prepare(first);
    const request = sentChecks(first)[0];
    filesClose.reply(first, { requestId: request?.requestId, answer: "checking" });
    filesClose.reply(second, { requestId: request?.requestId, answer: "allow" });
    filesClose.reply(first, { requestId: (request?.requestId as number) + 1, answer: "allow" });
    filesClose.reply(first, { requestId: request?.requestId, answer: "cancel" });
    expect(await outcome).toBe(false);
    expect(filesClose.holds(first)).toBe(false);
  });

  it("refuses a check the renderer never acknowledges", async () => {
    const timers: Array<() => void> = [];
    const filesClose = createDesktopFilesClose({
      timer: {
        set: (callback) => {
          timers.push(callback);
          return 0 as never;
        },
        clear: () => undefined,
      },
    });
    const window = fakeWindow();
    const outcome = filesClose.prepare(window);
    expect(timers).toHaveLength(1);
    timers.forEach((fire) => fire());
    expect(await outcome).toBe(false);
    expect(filesClose.holds(window)).toBe(false);
  });

  it("does not open a second prompt while a request stands", async () => {
    const filesClose = createDesktopFilesClose();
    const window = fakeWindow();
    const first = filesClose.prepare(window);
    expect(await filesClose.prepare(window)).toBe(false);
    expect(sentChecks(window)).toHaveLength(1);
    filesClose.reply(window, { requestId: sentChecks(window)[0]?.requestId, answer: "cancel" });
    expect(await first).toBe(false);
  });

  it("retires a pending request when its renderer navigates to a new document", async () => {
    const filesClose = createDesktopFilesClose();
    const window = fakeWindow();
    filesClose.install(window);
    const outcome = filesClose.prepare(window);
    // A hash-only change keeps the renderer that was asked.
    window.emitNavigation(true, true);
    filesClose.reply(window, { requestId: sentChecks(window)[0]?.requestId, answer: "checking" });
    window.emitNavigation(false, true);
    expect(await outcome).toBe(false);
    expect(filesClose.holds(window)).toBe(false);
  });

  it("leaves every window open and releases the accepted one when a later check cancels", async () => {
    const filesClose = createDesktopFilesClose();
    const first = fakeWindow();
    const second = fakeWindow();
    const windows = [first, second];
    const outcome = filesClose.prepareAll(() => windows);
    // The checks run in order: the second is only asked after the first held.
    expect(sentChecks(first)).toHaveLength(1);
    expect(sentChecks(second)).toHaveLength(0);
    const firstId = sentChecks(first)[0]?.requestId;
    filesClose.reply(first, { requestId: firstId, answer: "checking" });
    filesClose.reply(first, { requestId: firstId, answer: "allow" });
    await vi.waitFor(() => expect(sentChecks(second)).toHaveLength(1));
    const secondId = sentChecks(second)[0]?.requestId;
    filesClose.reply(second, { requestId: secondId, answer: "checking" });
    filesClose.reply(second, { requestId: secondId, answer: "cancel" });
    expect(await outcome).toBe(false);
    expect(filesClose.holds(first)).toBe(false);
    expect(first.webContents.send).toHaveBeenLastCalledWith(
      DESKTOP_IPC_CHANNELS.filesCloseRequest,
      { requestId: firstId, kind: "release" },
    );
  });

  it("refuses the preflight when a window joined under it", async () => {
    const filesClose = createDesktopFilesClose();
    const first = fakeWindow();
    const joined = fakeWindow();
    const windows = [first];
    // A fresh snapshot each call is how a joined window is caught at the end.
    const outcome = filesClose.prepareAll(() => [...windows]);
    const id = sentChecks(first)[0]?.requestId;
    filesClose.reply(first, { requestId: id, answer: "checking" });
    filesClose.reply(first, { requestId: id, answer: "allow" });
    windows.push(joined);
    expect(await outcome).toBe(false);
    expect(filesClose.holds(first)).toBe(false);
  });

  it("refuses the preflight when a window left under it", async () => {
    const filesClose = createDesktopFilesClose();
    const first = fakeWindow();
    const gone = fakeWindow();
    const windows = [first, gone];
    filesClose.install(gone);
    const outcome = filesClose.prepareAll(() => [...windows]);
    const firstId = sentChecks(first)[0]?.requestId;
    filesClose.reply(first, { requestId: firstId, answer: "checking" });
    filesClose.reply(first, { requestId: firstId, answer: "allow" });
    // The second window is asked only after the first held; closing it while
    // its check is out ends the whole quit rather than approving a subset.
    await vi.waitFor(() => expect(sentChecks(gone)).toHaveLength(1));
    const goneId = sentChecks(gone)[0]?.requestId;
    filesClose.reply(gone, { requestId: goneId, answer: "checking" });
    gone.emitClosed();
    windows.splice(1, 1);
    expect(await outcome).toBe(false);
    expect(filesClose.holds(first)).toBe(false);
  });

  it("unlocks a renderer whose acknowledgement never arrives and ignores late replies", async () => {
    const timers: Array<() => void> = [];
    const filesClose = createDesktopFilesClose({
      timer: {
        set: (callback) => {
          timers.push(callback);
          return 0 as never;
        },
        clear: () => undefined,
      },
    });
    const window = fakeWindow();
    const outcome = filesClose.prepare(window);
    const id = sentChecks(window)[0]?.requestId;
    timers.forEach((fire) => fire());
    expect(await outcome).toBe(false);
    // The window is told the request is gone, so a prompt it might still show
    // resolves instead of holding the document inert forever.
    expect(window.webContents.send).toHaveBeenLastCalledWith(
      DESKTOP_IPC_CHANNELS.filesCloseRequest,
      { requestId: id, kind: "release" },
    );
    expect(filesClose.reply(window, { requestId: id, answer: "checking" })).toBe(false);
    expect(filesClose.reply(window, { requestId: id, answer: "allow" })).toBe(false);
  });

  it("answers whether each reply actually landed on its own request", async () => {
    const filesClose = createDesktopFilesClose();
    const window = fakeWindow();
    const outcome = filesClose.prepare(window);
    const id = sentChecks(window)[0]?.requestId;
    expect(filesClose.reply(window, null)).toBe(false);
    expect(filesClose.reply(window, { requestId: id, answer: "checking" })).toBe(true);
    expect(filesClose.reply(window, { requestId: id, answer: "checking" })).toBe(false);
    expect(filesClose.reply(window, { requestId: id, answer: "allow" })).toBe(true);
    // A cancel cannot take back an approval that is already held.
    expect(filesClose.reply(window, { requestId: id, answer: "cancel" })).toBe(false);
    expect(await outcome).toBe(true);
  });

  it("keeps an approved hold until the window itself closes", async () => {
    const filesClose = createDesktopFilesClose();
    const window = fakeWindow();
    filesClose.install(window);
    const outcome = filesClose.prepare(window);
    const id = sentChecks(window)[0]?.requestId;
    filesClose.reply(window, { requestId: id, answer: "checking" });
    filesClose.reply(window, { requestId: id, answer: "allow" });
    expect(await outcome).toBe(true);
    window.emitClosed();
    expect(filesClose.holds(window)).toBe(false);
  });
});

describe("the native quit preflight policy", () => {
  const cases: ReadonlyArray<
    readonly [string, Parameters<typeof shouldPreflightNativeQuit>[0], boolean]
  > = [
    [
      "an unmarked macOS quit with windows asks",
      {
        platform: "darwin",
        hasWindows: true,
        systemShuttingDown: false,
        internalQuit: false,
      },
      true,
    ],
    [
      "a system shutdown never asks",
      {
        platform: "darwin",
        hasWindows: true,
        systemShuttingDown: true,
        internalQuit: false,
      },
      false,
    ],
    [
      "an updater or relaunch exit never asks",
      {
        platform: "darwin",
        hasWindows: true,
        systemShuttingDown: false,
        internalQuit: true,
      },
      false,
    ],
    [
      "a non-Mac quit never asks",
      {
        platform: "linux",
        hasWindows: true,
        systemShuttingDown: false,
        internalQuit: false,
      },
      false,
    ],
    [
      "a macOS quit without windows asks nobody",
      {
        platform: "darwin",
        hasWindows: false,
        systemShuttingDown: false,
        internalQuit: false,
      },
      false,
    ],
  ];
  for (const [title, input, expected] of cases)
    it(title, () => expect(shouldPreflightNativeQuit(input)).toBe(expected));
});

describe("the prompting reply", () => {
  it("raises only the window whose renderer is actually prompting", async () => {
    const filesClose = createDesktopFilesClose();
    const first = fakeWindow();
    const second = fakeWindow();
    const windows = [first, second];
    const outcome = filesClose.prepareAll(() => windows);
    const firstId = sentChecks(first)[0]?.requestId;
    filesClose.reply(first, { requestId: firstId, answer: "checking" });
    filesClose.reply(first, { requestId: firstId, answer: "allow" });
    await vi.waitFor(() => expect(sentChecks(second)).toHaveLength(1));
    const secondId = sentChecks(second)[0]?.requestId;
    filesClose.reply(second, { requestId: secondId, answer: "checking" });
    expect(filesClose.reply(second, { requestId: secondId, answer: "prompting" })).toBe(true);
    expect(second.show).toHaveBeenCalledOnce();
    expect(second.focus).toHaveBeenCalledOnce();
    // The clean window's renderer never prompted, so it never rose.
    expect(first.show).not.toHaveBeenCalled();
    expect(first.focus).not.toHaveBeenCalled();
    filesClose.reply(second, { requestId: secondId, answer: "allow" });
    expect(await outcome).toBe(true);
  });

  it("does not focus again when the renderer announces its prompt twice", async () => {
    const filesClose = createDesktopFilesClose();
    const window = fakeWindow();
    const outcome = filesClose.prepare(window);
    const id = sentChecks(window)[0]?.requestId;
    filesClose.reply(window, { requestId: id, answer: "checking" });
    expect(filesClose.reply(window, { requestId: id, answer: "prompting" })).toBe(true);
    expect(filesClose.reply(window, { requestId: id, answer: "prompting" })).toBe(true);
    expect(window.show).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
    filesClose.reply(window, { requestId: id, answer: "allow" });
    expect(await outcome).toBe(true);
  });

  it("refuses a prompting that arrives before the acknowledgement or after allow", async () => {
    const filesClose = createDesktopFilesClose();
    const window = fakeWindow();
    const outcome = filesClose.prepare(window);
    const id = sentChecks(window)[0]?.requestId;
    expect(filesClose.reply(window, { requestId: id, answer: "prompting" })).toBe(false);
    filesClose.reply(window, { requestId: id, answer: "checking" });
    filesClose.reply(window, { requestId: id, answer: "allow" });
    expect(filesClose.reply(window, { requestId: id, answer: "prompting" })).toBe(false);
    expect(await outcome).toBe(true);
    expect(window.show).not.toHaveBeenCalled();
  });
});

describe("the unavailable-renderer fallback", () => {
  const pendingConfirmation = () => {
    let answer: ((allowed: boolean) => void) | undefined;
    let signal: AbortSignal | undefined;
    const confirm = (_window: BrowserWindow, itsSignal: AbortSignal) => {
      signal = itsSignal;
      return new Promise<boolean>((resolve) => {
        answer = resolve;
      });
    };
    return {
      confirm,
      respond: (allowed: boolean) => answer?.(allowed),
      signal: () => signal,
    };
  };

  it("asks natively when the acknowledgement times out, and Cancel keeps the window", async () => {
    const timers: Array<() => void> = [];
    const pending = pendingConfirmation();
    const filesClose = createDesktopFilesClose({
      confirmUnavailable: pending.confirm,
      timer: {
        set: (callback) => {
          timers.push(callback);
          return 0 as never;
        },
        clear: () => undefined,
      },
    });
    const window = fakeWindow();
    const outcome = filesClose.prepare(window);
    const id = sentChecks(window)[0]?.requestId;
    timers.forEach((fire) => fire());
    await vi.waitFor(() => expect(pending.signal()).toBeDefined());
    // The fallback raised the window it is asking about, and the renderer
    // was released by id so a stale prompt cannot hold it inert.
    expect(window.focus).toHaveBeenCalled();
    expect(window.webContents.send).toHaveBeenLastCalledWith(
      DESKTOP_IPC_CHANNELS.filesCloseRequest,
      { requestId: id, kind: "release" },
    );
    pending.respond(false);
    expect(await outcome).toBe(false);
    expect(filesClose.holds(window)).toBe(false);
  });

  it("turns an explicit native approval into the same hold a renderer's would be", async () => {
    const timers: Array<() => void> = [];
    const pending = pendingConfirmation();
    const filesClose = createDesktopFilesClose({
      confirmUnavailable: pending.confirm,
      timer: {
        set: (callback) => {
          timers.push(callback);
          return 0 as never;
        },
        clear: () => undefined,
      },
    });
    const window = fakeWindow();
    const outcome = filesClose.prepare(window);
    timers.forEach((fire) => fire());
    await vi.waitFor(() => expect(pending.signal()).toBeDefined());
    pending.respond(true);
    expect(await outcome).toBe(true);
    expect(filesClose.holds(window)).toBe(true);
  });

  it("ignores every renderer reply while the native fallback owns the question", async () => {
    const timers: Array<() => void> = [];
    const pending = pendingConfirmation();
    const filesClose = createDesktopFilesClose({
      confirmUnavailable: pending.confirm,
      timer: {
        set: (callback) => {
          timers.push(callback);
          return 0 as never;
        },
        clear: () => undefined,
      },
    });
    const window = fakeWindow();
    const outcome = filesClose.prepare(window);
    const id = sentChecks(window)[0]?.requestId;
    timers.forEach((fire) => fire());
    await vi.waitFor(() => expect(pending.signal()).toBeDefined());
    // A late renderer answer — even a cancel — cannot take over the fallback.
    expect(filesClose.reply(window, { requestId: id, answer: "checking" })).toBe(false);
    expect(filesClose.reply(window, { requestId: id, answer: "prompting" })).toBe(false);
    expect(filesClose.reply(window, { requestId: id, answer: "cancel" })).toBe(false);
    expect(filesClose.reply(window, { requestId: id, answer: "allow" })).toBe(false);
    pending.respond(false);
    expect(await outcome).toBe(false);
  });

  it("cannot hold a window whose fallback was released before the answer arrived", async () => {
    const timers: Array<() => void> = [];
    const pending = pendingConfirmation();
    const filesClose = createDesktopFilesClose({
      confirmUnavailable: pending.confirm,
      timer: {
        set: (callback) => {
          timers.push(callback);
          return 0 as never;
        },
        clear: () => undefined,
      },
    });
    const window = fakeWindow();
    const outcome = filesClose.prepare(window);
    timers.forEach((fire) => fire());
    await vi.waitFor(() => expect(pending.signal()).toBeDefined());
    filesClose.release(window);
    expect(pending.signal()?.aborted).toBe(true);
    // The release already answered this request: a late yes holds nothing.
    pending.respond(true);
    expect(await outcome).toBe(false);
    expect(filesClose.holds(window)).toBe(false);
  });

  it("rolls back a renderer-approved window when a later window's fallback cancels", async () => {
    const timers: Array<() => void> = [];
    const pending = pendingConfirmation();
    const filesClose = createDesktopFilesClose({
      confirmUnavailable: pending.confirm,
      timer: {
        set: (callback) => {
          timers.push(callback);
          return 0 as never;
        },
        clear: () => undefined,
      },
    });
    const first = fakeWindow();
    const second = fakeWindow();
    const windows = [first, second];
    const outcome = filesClose.prepareAll(() => windows);
    const firstId = sentChecks(first)[0]?.requestId;
    filesClose.reply(first, { requestId: firstId, answer: "checking" });
    filesClose.reply(first, { requestId: firstId, answer: "allow" });
    await vi.waitFor(() => expect(sentChecks(second)).toHaveLength(1));
    // The second window's renderer never answers; its fallback cancels.
    timers.forEach((fire) => fire());
    await vi.waitFor(() => expect(pending.signal()).toBeDefined());
    pending.respond(false);
    expect(await outcome).toBe(false);
    expect(filesClose.holds(first)).toBe(false);
    expect(first.webContents.send).toHaveBeenLastCalledWith(
      DESKTOP_IPC_CHANNELS.filesCloseRequest,
      { requestId: firstId, kind: "release" },
    );
  });

  it("treats a renderer dying with an unanswered check as unavailable", async () => {
    const pending = pendingConfirmation();
    const filesClose = createDesktopFilesClose({ confirmUnavailable: pending.confirm });
    const window = fakeWindow();
    filesClose.install(window);
    const outcome = filesClose.prepare(window);
    window.emitRendererGone();
    await vi.waitFor(() => expect(pending.signal()).toBeDefined());
    pending.respond(true);
    expect(await outcome).toBe(true);
    expect(filesClose.holds(window)).toBe(true);
  });
});
