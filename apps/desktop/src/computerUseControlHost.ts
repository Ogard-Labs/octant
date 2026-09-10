import { createHash, randomUUID } from "node:crypto";
import {
  decodeComputerControlResult,
  type ComputerControlCommand,
  type ComputerControlResult,
  type ComputerUseOwner,
} from "@octant/contracts/computer-use-plugin";
import type { ComputerDriverRuntime } from "./computerUseSdkRuntime";

interface ObservedWindow {
  readonly id: string;
  readonly generation: string;
  readonly appId: string;
  readonly pid: number;
  readonly windowId: number;
  readonly snapshotId: string;
  readonly elements: ReadonlyArray<Record<string, unknown>>;
  readonly imageWidth?: number;
  readonly imageHeight?: number;
}
interface OwnedSession {
  readonly owner: ComputerUseOwner;
  readonly id: string;
  readonly abort: AbortController;
  readonly pending: Set<Promise<ComputerControlResult>>;
  readonly observations: Map<string, ObservedWindow>;
  timer: ReturnType<typeof setTimeout>;
}
const reservedApps = new Set([
  "app.octant.desktop",
  "com.apple.systempreferences",
  "com.trycua.driver",
]);
const interpreterApps = new Set([
  "com.apple.Terminal",
  "com.googlecode.iterm2",
  "com.apple.ScriptEditor2",
  "com.apple.Automator",
]);
const APP_ID = /^[A-Za-z0-9][A-Za-z0-9.-]{0,255}$/;
const SESSION_MS = 5 * 60 * 1_000;
const refused = (reason: string, message: string): ComputerControlResult => ({
  kind: "refused",
  reason,
  message,
});
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function key(owner: ComputerUseOwner): string {
  return `${owner.windowId}:${owner.threadId}`;
}
function sameOwner(a: ComputerUseOwner, b: ComputerUseOwner): boolean {
  return (
    a.windowId === b.windowId &&
    a.threadId === b.threadId &&
    a.mode === b.mode &&
    a.providerInstanceId === b.providerInstanceId &&
    a.modelId === b.modelId &&
    a.executionPolicy === b.executionPolicy
  );
}

/** Exact window leases and observations are shared by every supported provider. */
export function createComputerUseControlHost(options: {
  readonly runtime: () => Promise<ComputerDriverRuntime>;
  readonly endSession?: (sessionId: string) => Promise<void>;
  readonly onIdle?: () => void;
}) {
  const sessions = new Map<string, OwnedSession>();
  const windowOwners = new Map<string, string>();
  let tail = Promise.resolve();
  let closed = false;

  async function release(owner: ComputerUseOwner): Promise<void> {
    const scope = key(owner);
    const session = sessions.get(scope);
    if (session === undefined || !sameOwner(session.owner, owner)) return;
    session.abort.abort();
    clearTimeout(session.timer);
    await Promise.allSettled([...session.pending]);
    try {
      await options.endSession?.(session.id);
    } catch {
      /* A stopped driver has already released its sessions. */
    }
    if (sessions.get(scope) !== session) return;
    sessions.delete(scope);
    for (const [window, ownerKey] of windowOwners)
      if (ownerKey === scope) windowOwners.delete(window);
    if (sessions.size === 0) options.onIdle?.();
  }

  async function reserve(owner: ComputerUseOwner): Promise<OwnedSession | undefined> {
    if (closed || owner.executionPolicy === "plan") return undefined;
    const scope = key(owner);
    const previous = sessions.get(scope);
    if (
      previous !== undefined &&
      sameOwner(previous.owner, owner) &&
      !previous.abort.signal.aborted
    )
      return previous;
    if (previous !== undefined) await release(previous.owner);
    if (closed || sessions.size >= 8) return undefined;
    const timer = setTimeout(() => {
      void release(owner);
    }, SESSION_MS);
    timer.unref();
    const session: OwnedSession = {
      owner,
      id: `octant-${randomUUID()}`,
      abort: new AbortController(),
      pending: new Set(),
      observations: new Map(),
      timer,
    };
    sessions.set(scope, session);
    return session;
  }

  async function execute(
    owner: ComputerUseOwner,
    command: ComputerControlCommand,
    signal?: AbortSignal,
  ): Promise<ComputerControlResult> {
    if (command.operation === "stop") {
      await release(owner);
      return { kind: "stopped" };
    }
    const session = await reserve(owner);
    if (session === undefined)
      return refused("unavailable", "Computer use is unavailable in this task or access posture.");
    if (session.pending.size >= 8)
      return refused("busy", "Computer use already has pending actions for this task.");
    const combined = AbortSignal.any([
      session.abort.signal,
      ...(signal === undefined ? [] : [signal]),
    ]);
    const pending = tail.then(async () => {
      if (combined.aborted) return refused("cancelled", "Computer use was cancelled.");
      try {
        const runtime = await options.runtime();
        const call = async (name: string, args: Readonly<Record<string, unknown>>) => {
          const response = await runtime.call(name, args, combined);
          if (response.isError) throw new Error("The driver refused the request.");
          const data: unknown = JSON.parse(response.structuredJson ?? "{}");
          if (!record(data)) throw new Error("Driver response is invalid.");
          return { data, images: response.images };
        };
        const appProcess = async (appId: string): Promise<number | undefined> => {
          const { data } = await call("list_apps", {});
          if (!Array.isArray(data.apps)) return undefined;
          const matches = data.apps.filter(
            (candidate: unknown) =>
              record(candidate) && candidate.bundle_id === appId && candidate.running === true,
          );
          if (matches.length !== 1) return undefined;
          const app = matches[0];
          return record(app) &&
            app.running === true &&
            Number.isSafeInteger(app.pid) &&
            typeof app.pid === "number" &&
            app.pid > 0
            ? app.pid
            : undefined;
        };
        const observe = async (appId: string, pid: number, windowId: number) => {
          const lease = `${pid}:${windowId}`;
          if (windowOwners.has(lease) && windowOwners.get(lease) !== key(owner)) return undefined;
          const response = await call("get_window_state", {
            pid,
            window_id: windowId,
            include_screenshot: true,
            max_dimension: 1280,
            max_elements: 512,
          });
          if (
            typeof response.data.snapshot_id !== "string" ||
            !/^s[0-9a-f]{8}$/.test(response.data.snapshot_id) ||
            !Array.isArray(response.data.elements)
          )
            throw new Error("Driver snapshot is invalid.");
          const scopedElements = windowElements(response.data.elements.filter(record));
          const projected = boundedElements(scopedElements);
          const elements = projected.map((item) => item.source);
          const imageWidth =
            response.images.length > 0 &&
            typeof response.data.screenshot_width === "number" &&
            Number.isSafeInteger(response.data.screenshot_width) &&
            response.data.screenshot_width > 0
              ? response.data.screenshot_width
              : undefined;
          const imageHeight =
            response.images.length > 0 &&
            typeof response.data.screenshot_height === "number" &&
            Number.isSafeInteger(response.data.screenshot_height) &&
            response.data.screenshot_height > 0
              ? response.data.screenshot_height
              : undefined;
          const observation: ObservedWindow = {
            id: randomUUID(),
            generation: runtime.generation,
            appId,
            pid,
            windowId,
            snapshotId: response.data.snapshot_id,
            elements,
            ...(imageWidth === undefined || imageHeight === undefined
              ? {}
              : { imageWidth, imageHeight }),
          };
          windowOwners.set(lease, key(owner));
          for (const [id, old] of session.observations)
            if (old.pid === pid && old.windowId === windowId) session.observations.delete(id);
          session.observations.set(observation.id, observation);
          const image = response.images[0];
          const result = decodeComputerControlResult({
            kind: "observation",
            observationId: observation.id,
            appId,
            windowId,
            ...(imageWidth === undefined || imageHeight === undefined
              ? {}
              : { imageWidth, imageHeight }),
            elements: projected.map((item) => item.value),
            truncated:
              elements.length < scopedElements.length ||
              response.data.elements_complete === false ||
              response.data.truncated === true,
            ...(image === undefined || image.dataBase64.length > 2_097_152
              ? {}
              : { image: { mimeType: image.mimeType, data: image.dataBase64 } }),
          });
          return { observation, result };
        };

        if (command.operation === "apps") {
          const { data } = await call("list_apps", {});
          if (!Array.isArray(data.apps)) throw new Error("App list is invalid.");
          return decodeComputerControlResult({
            kind: "apps",
            apps: data.apps
              .filter(record)
              .flatMap((app) =>
                typeof app.bundle_id === "string" &&
                APP_ID.test(app.bundle_id) &&
                typeof app.name === "string" &&
                !reservedApps.has(app.bundle_id) &&
                !interpreterApps.has(app.bundle_id)
                  ? [{ appId: app.bundle_id, name: app.name.slice(0, 256) }]
                  : [],
              ),
          });
        }
        if ("appId" in command) {
          if (reservedApps.has(command.appId) || interpreterApps.has(command.appId))
            return refused(
              "reserved-app",
              "Use Octant's permission setup or approved shell tools for this application.",
            );
          if (command.operation === "launch")
            await call("launch_app", { bundle_id: command.appId });
          const pid = await appProcess(command.appId);
          if (pid === undefined || pid === process.pid)
            return refused(
              "app-unavailable",
              "The application is not running or cannot be controlled.",
            );
          if (command.operation !== "observe") {
            const { data } = await call("list_windows", { pid });
            if (!Array.isArray(data.windows)) throw new Error("Window list is invalid.");
            return decodeComputerControlResult({
              kind: "windows",
              appId: command.appId,
              windows: data.windows.filter(record).map((window) => ({
                windowId: window.window_id,
                title: typeof window.title === "string" ? window.title.slice(0, 1_024) : "",
              })),
            });
          }
          const next = await observe(command.appId, pid, command.windowId);
          return (
            next?.result ?? refused("window-owned", "Another task owns this application window.")
          );
        }

        const old = session.observations.get(command.observationId);
        if (old === undefined || old.generation !== runtime.generation)
          return refused("stale-observation", "Observe this window again before acting.");
        if ((await appProcess(old.appId)) !== old.pid)
          return refused("stale-observation", "The application process changed. Observe it again.");
        const before = await observe(old.appId, old.pid, old.windowId);
        if (before === undefined) return refused("window-owned", "Another task owns this window.");
        let element: Record<string, unknown> | undefined;
        if (command.operation === "click" && "x" in command) {
          if (
            old.imageWidth === undefined ||
            old.imageHeight === undefined ||
            before.observation.imageWidth !== old.imageWidth ||
            before.observation.imageHeight !== old.imageHeight ||
            command.x >= old.imageWidth ||
            command.y >= old.imageHeight
          )
            return refused(
              "invalid-image-position",
              "Use a position inside the latest returned window screenshot.",
            );
          if (before.observation.elements.some(isProtected))
            return refused(
              "protected-field",
              "Use an observed accessibility element rather than a pixel click while protected fields are present.",
            );
        }
        if ("elementIndex" in command) {
          const previous = old.elements.find((item) => item.element_index === command.elementIndex);
          element = before.observation.elements.find(
            (item) => item.element_index === command.elementIndex,
          );
          if (
            element === undefined ||
            previous === undefined ||
            elementFingerprint(element) !== elementFingerprint(previous)
          )
            return refused(
              "stale-observation",
              "The selected element changed. Observe the window again.",
            );
          if (isProtected(element))
            return refused(
              "protected-field",
              "Computer use cannot interact with this protected field.",
            );
          if (
            command.operation === "type" &&
            !["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"].includes(
              String(element.role),
            )
          )
            return refused("not-a-text-field", "Choose an observed text field for typing.");
        }
        const address = {
          pid: old.pid,
          window_id: old.windowId,
          snapshot_id: before.observation.snapshotId,
          session: session.id,
          delivery_mode: "background",
          ...("elementIndex" in command ? { element_index: command.elementIndex } : {}),
        };
        await call("start_session", { session: session.id });
        if (command.operation === "click")
          await call("click", {
            ...address,
            ...("x" in command ? { x: command.x, y: command.y } : {}),
          });
        else if (command.operation === "type")
          await call("type_text", { ...address, text: command.text });
        else if (command.operation === "press")
          await call("press_key", { ...address, key: command.key });
        else
          await call("scroll", {
            pid: old.pid,
            window_id: old.windowId,
            session: session.id,
            direction: command.direction,
            amount: command.amount,
          });
        const after = await observe(old.appId, old.pid, old.windowId);
        return (
          after?.result ??
          refused("window-unavailable", "The window is no longer available for verification.")
        );
      } catch {
        return refused(
          combined.aborted ? "cancelled" : "driver-unavailable",
          combined.aborted
            ? "Computer use was cancelled."
            : "Computer use could not complete or verify this action. Observe the application again before retrying.",
        );
      }
    });
    session.pending.add(pending);
    tail = pending.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await pending;
    } finally {
      session.pending.delete(pending);
    }
  }

  return {
    reserve: async (owner: ComputerUseOwner) => (await reserve(owner)) !== undefined,
    execute,
    release,
    activeSessions: () => sessions.size,
    revokeAll: async () => {
      await Promise.all([...sessions.values()].map((session) => release(session.owner)));
    },
    close: async () => {
      closed = true;
      await Promise.all([...sessions.values()].map((session) => release(session.owner)));
    },
  };
}

function isProtected(element: Record<string, unknown>): boolean {
  return (
    /secure|password/i.test(
      `${String(element.role)} ${String(element.subrole)} ${String(element.value_description)}`,
    ) ||
    /password|passcode|credit.card|security.code|one.time|api.key|private.key|recovery.key/i.test(
      String(element.label),
    )
  );
}

// Cua snapshots append the app menu after the exact window. Those controls
// can leave the approved window (including system power and privacy actions).
function windowElements(
  elements: ReadonlyArray<Record<string, unknown>>,
): ReadonlyArray<Record<string, unknown>> {
  const root = elements.find(
    (element) => element.role === "AXWindow" && element.parent_index === undefined,
  );
  if (root === undefined) throw new Error("Driver did not resolve the requested window.");
  const included = new Set<unknown>([root.element_index]);
  return elements.filter((element) => {
    if (element === root) return true;
    if (!included.has(element.parent_index)) return false;
    included.add(element.element_index);
    return true;
  });
}

function boundedElements(elements: ReadonlyArray<Record<string, unknown>>) {
  let bytes = 0;
  return elements.slice(0, 256).flatMap((element) => {
    if (
      typeof element.element_index !== "number" ||
      !Number.isSafeInteger(element.element_index) ||
      typeof element.role !== "string"
    )
      return [];
    const protectedField = isProtected(element);
    const value = {
      index: element.element_index,
      role: element.role.slice(0, 128),
      label: typeof element.label === "string" ? element.label.slice(0, 2_048) : "",
      protected: protectedField,
      ...(!protectedField && typeof element.value === "string"
        ? { value: element.value.slice(0, 4_096) }
        : {}),
    };
    bytes += Buffer.byteLength(JSON.stringify(value));
    return bytes > 32_768 ? [] : [{ source: element, value }];
  });
}

function elementFingerprint(element: Record<string, unknown>): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        element.role,
        element.label,
        element.value,
        element.frame,
        element.parent_index,
      ]),
    )
    .digest("hex");
}
