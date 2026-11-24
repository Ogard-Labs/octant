import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  decodeDesktopViewId,
  decodeHostDisplayAnswer,
  type HostDisplayAnswer,
  type HostDisplayScope,
  type HostDisplayRequest,
} from "@octant/contracts";

type NativeRequest =
  | Extract<HostDisplayRequest, { readonly action: "input" }>
  | { readonly action: "frame" };

export function nativeHostDisplay(
  path: string,
  request: NativeRequest,
  signal: AbortSignal,
): Promise<HostDisplayAnswer> {
  return new Promise((resolve) => {
    const refused = { status: "refused", reason: "view-ended" } as const;
    const child = execFile(
      path,
      ["--host-display"],
      {
        signal,
        timeout: 4000,
        killSignal: "SIGKILL",
        maxBuffer: 2_100_000,
        env: {},
        encoding: "utf8",
      },
      (error, stdout) => {
        if (error !== null) return resolve(refused);
        try {
          resolve(decodeHostDisplayAnswer(JSON.parse(stdout)));
        } catch {
          resolve(refused);
        }
      },
    );
    child.stdin?.on("error", () => resolve(refused));
    child.stdin?.end(JSON.stringify(request));
  });
}

interface View {
  readonly id: ReturnType<typeof decodeDesktopViewId>;
  readonly scope: HostDisplayScope;
  readonly thread: string;
  readonly abort: AbortController;
  readonly started: number;
  control: "watch" | "taking" | "person";
  reading: boolean;
  input: boolean;
  timer: ReturnType<typeof setTimeout>;
}

/** The host's logged-in display is shared by every thread. At most one device holds it. */
export function createHostDisplay(options: {
  readonly available: () => boolean;
  readonly drainAgentInput: () => Promise<void>;
  readonly native: (request: NativeRequest, signal: AbortSignal) => Promise<HostDisplayAnswer>;
}) {
  let view: View | undefined;
  const refused = (reason: "not-permitted" | "view-ended" | "view-limit") =>
    ({ status: "refused", reason }) as const;
  function close() {
    if (!view) return;
    clearTimeout(view.timer);
    view.abort.abort();
    view = undefined;
  }
  function timer() {
    const idle = setTimeout(close, 20_000);
    idle.unref();
    return idle;
  }
  async function request(
    scope: HostDisplayScope,
    command: HostDisplayRequest,
    signal?: AbortSignal,
  ): Promise<HostDisplayAnswer> {
    if (signal?.aborted) return refused("view-ended");
    if (!options.available()) {
      close();
      return refused("not-permitted");
    }
    if (command.action === "open") {
      if (view) return refused("view-limit");
      view = {
        id: decodeDesktopViewId(randomUUID()),
        scope,
        thread: command.threadId,
        abort: new AbortController(),
        started: Date.now(),
        control: "watch",
        reading: false,
        input: false,
        timer: timer(),
      };
      return { status: "viewing", viewId: view.id };
    }
    const current = view;
    if (
      !current ||
      current.id !== command.viewId ||
      current.scope.deviceId !== scope.deviceId ||
      current.scope.sessionId !== scope.sessionId ||
      current.scope.generation !== scope.generation ||
      current.thread !== command.threadId
    )
      return refused("view-ended");
    if (Date.now() - current.started >= 4 * 60 * 60 * 1000) {
      close();
      return refused("view-ended");
    }
    clearTimeout(current.timer);
    current.timer = timer();
    if (command.action === "close") {
      close();
      return { status: "view-closed" };
    }
    if (command.action === "take-control") {
      if (current.control !== "watch") return refused("not-permitted");
      current.control = "taking";
      try {
        await options.drainAgentInput();
      } catch {
        if (view === current) close();
        return refused("view-ended");
      }
      if (view !== current || !options.available()) return refused("view-ended");
      if (signal?.aborted) {
        close();
        return refused("view-ended");
      }
      current.control = "person";
      return { status: "delivered" };
    }
    if (command.action === "hand-back") {
      if (current.input || current.control !== "person") return { status: "not-delivered" };
      current.control = "watch";
      return { status: "delivered" };
    }
    if (command.action === "input" && current.control !== "person") return refused("not-permitted");
    const input = command.action === "input";
    if (input && current.input) return { status: "not-delivered" };
    if (!input && current.reading) return { status: "no-frame" };
    if (input) current.input = true;
    else current.reading = true;
    const disconnected = () => {
      if (view === current) close();
    };
    signal?.addEventListener("abort", disconnected, { once: true });
    try {
      const result = await options.native(
        command.action === "input" ? command : { action: "frame" },
        signal ? AbortSignal.any([signal, current.abort.signal]) : current.abort.signal,
      );
      if (view !== current) return refused("view-ended");
      if (!options.available() || result.status === "refused") {
        close();
        return refused("view-ended");
      }
      return result;
    } finally {
      signal?.removeEventListener("abort", disconnected);
      if (input) current.input = false;
      else current.reading = false;
    }
  }
  return {
    request,
    close,
    agentLifetime: (deviceId: string, threadId: string) =>
      view?.scope.deviceId === deviceId &&
      view.thread === threadId &&
      view.control === "watch" &&
      options.available()
        ? view.abort.signal
        : undefined,
    blocksAgent: () => view !== undefined && view.control !== "watch",
  };
}
