import { BROWSER_EDITABLE_WORLD_NAME } from "./browserEditableObservation";
import { readBrowserEditableInFrame } from "./browserEditableTarget";
import {
  autoAttachSurfaceFrames,
  findFrame,
  type ProtocolFrameTree,
  type SurfaceFrameTargets,
  type SurfaceProtocolListener,
  type SurfaceProtocolSend,
} from "./browserSurfaceFrames";

/**
 * Reaching the focused nested frame of Stable's hidden window for the
 * person's presentation.
 *
 * The preload observes every frame from document start, in isolated world
 * 1002. Electron evaluates in that world only in the main frame, so a frame's
 * world is found through Stable's own protocol attachment: by its name, in the
 * session that owns the frame. A frame on another site is its own target, and
 * the attachment's automatic frame attachment is shared with agent actions,
 * which still send their commands to the page itself.
 */

type Evaluate = (
  world: number,
  scripts: ReadonlyArray<{ readonly code: string }>,
) => Promise<unknown>;

export interface HumanFrameOffset {
  readonly x: number;
  readonly y: number;
  readonly scaleX: number;
  readonly scaleY: number;
}

/** The document that holds the person's focus, with where its content sits in the page. */
export interface HumanFrameScope {
  readonly evaluate: Evaluate;
  readonly offset: HumanFrameOffset;
  readonly nested: boolean;
}

const IDENTITY: HumanFrameOffset = Object.freeze({ x: 0, y: 0, scaleX: 1, scaleY: 1 });
/** Focus chains deeper than this are refused rather than followed. */
const MAX_FRAME_DEPTH = 8;
/** The bridge worlds Stable remembers across the page's frames. */
const MAX_BRIDGE_CONTEXTS = 256;
const READER_WORLD = "octant-human-frames";
const READER_GROUP = "octant-human-frames";

/** The focused frame element of a document, read in Stable's own isolated world. */
const FOCUSED_FRAME = `(() => {
  const element = document.activeElement;
  return element instanceof HTMLIFrameElement || element instanceof HTMLFrameElement ? element : null;
})()`;

/**
 * Where the focused frame's content starts and how its pixels are drawn,
 * without scrolling it: the person's page never moves for a caret lookup.
 */
const FOCUSED_FRAME_OFFSET = `(() => {
  const frame = document.activeElement;
  if (!(frame instanceof HTMLIFrameElement || frame instanceof HTMLFrameElement)) return null;
  const box = frame.getBoundingClientRect();
  const style = getComputedStyle(frame);
  const scaleX = frame.offsetWidth > 0 ? box.width / frame.offsetWidth : 1;
  const scaleY = frame.offsetHeight > 0 ? box.height / frame.offsetHeight : 1;
  return {
    x: box.left + (frame.clientLeft + (Number.parseFloat(style.paddingLeft) || 0)) * scaleX,
    y: box.top + (frame.clientTop + (Number.parseFloat(style.paddingTop) || 0)) * scaleY,
    scaleX,
    scaleY,
  };
})()`;

/** The longest a lookup waits for the page before it refuses. */
const FRAME_LOOKUP_MS = 1_000;

function deadline<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Browser frame did not answer.")), FRAME_LOOKUP_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function finiteOffset(value: unknown): HumanFrameOffset | undefined {
  if (!record(value)) return undefined;
  const { x, y, scaleX, scaleY } = value;
  return typeof x === "number" &&
    typeof y === "number" &&
    typeof scaleX === "number" &&
    typeof scaleY === "number" &&
    [x, y, scaleX, scaleY].every((part) => Number.isFinite(part) && Math.abs(part) <= 100_000) &&
    scaleX > 0 &&
    scaleY > 0
    ? { x, y, scaleX, scaleY }
    : undefined;
}

/** A point inside a frame, as drawn in the top page. */
export function mapHumanFramePoint(
  offset: HumanFrameOffset,
  point: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  },
) {
  return {
    x: offset.x + offset.scaleX * point.x,
    y: offset.y + offset.scaleY * point.y,
    width: offset.scaleX * point.width,
    height: offset.scaleY * point.height,
  };
}

export function humanFrameReach(options: {
  readonly send: SurfaceProtocolSend;
  readonly listen: (listener: SurfaceProtocolListener) => () => void;
  readonly targets: SurfaceFrameTargets;
  /** A frame target joined the page; its session needs the person's popup watch. */
  readonly frameSession: (sessionId: string) => void;
}) {
  const bridges = new Map<string, { readonly id: number; readonly uniqueId: string | undefined }>();
  const runtimes = new Map<string, Promise<void>>();
  const key = (sessionId: string | undefined, frameId: string) =>
    `${sessionId ?? ""}\u0000${frameId}`;
  const forgetSession = (sessionId: string | undefined) => {
    const prefix = `${sessionId ?? ""}\u0000`;
    for (const known of bridges.keys()) if (known.startsWith(prefix)) bridges.delete(known);
  };
  const stop = options.listen((_event, method, params, sessionId) => {
    if (!record(params)) return;
    if (method === "Runtime.executionContextCreated" && record(params.context)) {
      const context = params.context;
      const aux = record(context.auxData) ? context.auxData : undefined;
      if (
        context.name !== BROWSER_EDITABLE_WORLD_NAME ||
        aux?.type !== "isolated" ||
        typeof aux.frameId !== "string" ||
        typeof context.id !== "number"
      )
        return;
      const known = key(sessionId, aux.frameId);
      if (!bridges.has(known) && bridges.size >= MAX_BRIDGE_CONTEXTS) return;
      bridges.set(known, {
        id: context.id,
        uniqueId: typeof context.uniqueId === "string" ? context.uniqueId : undefined,
      });
      return;
    }
    if (method === "Runtime.executionContextDestroyed") {
      const prefix = `${sessionId ?? ""}\u0000`;
      for (const [known, bridge] of bridges)
        if (
          known.startsWith(prefix) &&
          (bridge.id === params.executionContextId ||
            (bridge.uniqueId !== undefined && bridge.uniqueId === params.executionContextUniqueId))
        )
          bridges.delete(known);
      return;
    }
    if (method === "Runtime.executionContextsCleared") return forgetSession(sessionId);
    if (method === "Target.detachedFromTarget") {
      if (typeof params.sessionId === "string") {
        forgetSession(params.sessionId);
        runtimes.delete(params.sessionId);
      }
      return;
    }
    if (
      method === "Target.attachedToTarget" &&
      typeof params.sessionId === "string" &&
      record(params.targetInfo) &&
      params.targetInfo.type === "iframe"
    )
      options.frameSession(params.sessionId);
  });

  const runtime = (sessionId: string | undefined): Promise<void> => {
    const known = sessionId ?? "";
    let enabled = runtimes.get(known);
    if (enabled === undefined) {
      // Enabling reports the session's existing worlds before it answers.
      // Bounded and forgotten on failure: a frame whose renderer stopped
      // answering must not hold every later lookup in that session.
      enabled = deadline(options.send("Runtime.enable", undefined, sessionId)).then(
        () => undefined,
      );
      runtimes.set(known, enabled);
      enabled.catch(() => runtimes.delete(known));
    }
    return enabled;
  };

  const readerWorld = async (frameId: string, sessionId: string | undefined) => {
    const created = await options.send(
      "Page.createIsolatedWorld",
      { frameId, worldName: READER_WORLD, grantUniveralAccess: false },
      sessionId,
    );
    if (!record(created) || typeof created.executionContextId !== "number")
      throw new Error("Browser frame could not be read.");
    return created.executionContextId;
  };

  const evaluateIn =
    (contextId: number, sessionId: string | undefined): Evaluate =>
    async (_world, scripts) => {
      const answer = await options.send(
        "Runtime.evaluate",
        { contextId, expression: scripts[0]?.code ?? "null", returnByValue: true },
        sessionId,
      );
      if (!record(answer) || answer.exceptionDetails !== undefined || !record(answer.result))
        return null;
      return answer.result.value ?? null;
    };

  /** The focused frame element's frame and where its content sits, from one document. */
  const focusedChild = async (frameId: string, sessionId: string | undefined) => {
    const contextId = await readerWorld(frameId, sessionId);
    try {
      const element = await options.send(
        "Runtime.evaluate",
        { contextId, expression: FOCUSED_FRAME, returnByValue: false, objectGroup: READER_GROUP },
        sessionId,
      );
      const objectId =
        record(element) && record(element.result) && typeof element.result.objectId === "string"
          ? element.result.objectId
          : undefined;
      if (objectId === undefined) return undefined;
      const described = await options.send("DOM.describeNode", { objectId }, sessionId);
      const childId =
        record(described) && record(described.node) && typeof described.node.frameId === "string"
          ? described.node.frameId
          : undefined;
      const offset = finiteOffset(
        await evaluateIn(contextId, sessionId)(0, [{ code: FOCUSED_FRAME_OFFSET }]),
      );
      return childId === undefined || offset === undefined ? undefined : { childId, offset };
    } finally {
      void options
        .send("Runtime.releaseObjectGroup", { objectGroup: READER_GROUP }, sessionId)
        .catch(() => undefined);
    }
  };

  /**
   * The document holding the person's focus. The top document answers through
   * Electron's own world; a nested frame through its named world. A chain that
   * cannot be followed refuses rather than guessing a document.
   */
  const walk = async (top: Evaluate): Promise<HumanFrameScope | undefined> => {
    if (!(await readBrowserEditableInFrame(top)))
      return { evaluate: top, offset: IDENTITY, nested: false };
    try {
      const tree = (await options.send("Page.getFrameTree")) as ProtocolFrameTree;
      let frameId = tree.frameTree?.frame?.id;
      let sessionId: string | undefined;
      let offset = IDENTITY;
      for (let depth = 0; depth < MAX_FRAME_DEPTH && typeof frameId === "string"; depth += 1) {
        const child = await focusedChild(frameId, sessionId);
        if (child === undefined) return undefined;
        // A frame on the parent's site shares its session; one on another
        // site is its own target, announced by automatic attachment.
        const own = (await options.send(
          "Page.getFrameTree",
          undefined,
          sessionId,
        )) as ProtocolFrameTree;
        const childSession =
          findFrame(own.frameTree, child.childId) !== undefined
            ? sessionId
            : (await autoAttachSurfaceFrames(options.send, options.targets, sessionId)).get(
                child.childId,
              )?.sessionId;
        if (childSession === undefined && findFrame(own.frameTree, child.childId) === undefined)
          return undefined;
        await runtime(childSession);
        const bridge = bridges.get(key(childSession, child.childId));
        if (bridge === undefined) return undefined;
        offset = {
          x: offset.x + offset.scaleX * child.offset.x,
          y: offset.y + offset.scaleY * child.offset.y,
          scaleX: offset.scaleX * child.offset.scaleX,
          scaleY: offset.scaleY * child.offset.scaleY,
        };
        const evaluate = evaluateIn(bridge.id, childSession);
        if (!(await readBrowserEditableInFrame(evaluate)))
          return { evaluate, offset, nested: true };
        frameId = child.childId;
        sessionId = childSession;
      }
      return undefined;
    } catch {
      return undefined;
    }
  };

  /**
   * One deadline covers the whole walk. The person's input queue awaits it, so
   * a frame that stops answering refuses the lookup instead of stalling input.
   */
  const focused = (top: Evaluate): Promise<HumanFrameScope | undefined> =>
    deadline(walk(top)).catch(() => undefined);

  return Object.freeze({
    focused,
    /** Ask for the page's frames on other sites, in the page or in one of its frame targets. */
    attach: (sessionId: string | undefined) =>
      autoAttachSurfaceFrames(options.send, options.targets, sessionId),
    stop: () => {
      stop();
      bridges.clear();
      runtimes.clear();
    },
  });
}
