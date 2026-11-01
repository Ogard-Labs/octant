import { browserFrameContentOffset, resolveBrowserElement } from "@octant/domain";

/**
 * Reaching a desktop page's frames through the debugger protocol.
 *
 * Electron runs the agent's page code in the top document's isolated world,
 * and a frame on another site lives in another renderer that world cannot
 * see. The protocol can: a frame element names its frame, a frame on another
 * site is its own target with its own session, and each frame gets an
 * isolated world of its own, so the page's scripts never see the reader.
 * Input still goes to the top page at page coordinates, which Chromium routes
 * to whichever frame is under the point.
 */

export type SurfaceProtocolSend = (
  method: string,
  parameters?: Record<string, unknown>,
  sessionId?: string,
) => Promise<unknown>;

export type SurfaceProtocolListener = (
  event: unknown,
  method: string,
  params: unknown,
  sessionId?: string,
) => void;

/** One frame's document, ready to run page code in. */
export interface SurfaceFrame {
  /** The protocol session that owns the frame; absent for the top page's own. */
  readonly sessionId?: string;
  readonly contextId: number;
  readonly url: string;
  /**
   * Where the frame's content starts in the top page's viewport, and how much
   * one of its pixels is drawn as there: a point inside the frame lands at
   * `offset + scale * point`.
   */
  readonly offset: {
    readonly x: number;
    readonly y: number;
    readonly scaleX: number;
    readonly scaleY: number;
  };
}

export type SurfaceFrameChild =
  | { readonly status: "included"; readonly frame: SurfaceFrame }
  | { readonly status: "excluded"; readonly origin?: string };

const WORLD_NAME = "octant-frames";

/**
 * The frame targets one debugger attachment knows. The protocol announces a
 * frame on another site once, when auto-attach turns on or when the frame
 * appears, so the record lives as long as the attachment does: a second
 * request to auto-attach in the same attachment announces nothing again.
 */
export interface SurfaceFrameTargets {
  readonly frames: Map<string, AttachedFrame>;
  readonly autoAttached: Map<string, Promise<void>>;
  readonly stop: () => void;
}

export function watchSurfaceFrameTargets(
  listen: (listener: SurfaceProtocolListener) => () => void,
): SurfaceFrameTargets {
  const frames = new Map<string, AttachedFrame>();
  const stop = listen((_event, method, params) => {
    const announced = (params ?? {}) as {
      readonly sessionId?: unknown;
      readonly targetInfo?: { readonly targetId?: unknown; readonly url?: unknown };
      readonly targetId?: unknown;
    };
    if (method === "Target.detachedFromTarget") {
      for (const [targetId, frame] of frames) {
        if (frame.sessionId === announced.sessionId || targetId === announced.targetId) {
          frames.delete(targetId);
        }
      }
      return;
    }
    if (
      method === "Target.attachedToTarget" &&
      typeof announced.sessionId === "string" &&
      typeof announced.targetInfo?.targetId === "string"
    ) {
      frames.set(announced.targetInfo.targetId, {
        sessionId: announced.sessionId,
        url: typeof announced.targetInfo.url === "string" ? announced.targetInfo.url : "",
      });
    }
  });
  return { frames, autoAttached: new Map(), stop };
}

export function surfaceFrames(options: {
  readonly send: SurfaceProtocolSend;
  readonly targets: SurfaceFrameTargets;
  /** Whether the agent may read and act in a frame at this address. */
  readonly admits: (url: string) => boolean;
}) {
  const evaluate = async (frame: SurfaceFrame, expression: string): Promise<unknown> => {
    const answer = (await options.send(
      "Runtime.evaluate",
      { contextId: frame.contextId, expression, returnByValue: true, awaitPromise: true },
      frame.sessionId,
    )) as ProtocolEvaluation;
    if (answer.exceptionDetails !== undefined) throw pageError(answer.exceptionDetails);
    return answer.result?.value;
  };

  /** The page object an expression returns, for a protocol call that takes an element. */
  const objectId = async (frame: SurfaceFrame, expression: string): Promise<string | undefined> => {
    const answer = (await options.send(
      "Runtime.evaluate",
      { contextId: frame.contextId, expression, returnByValue: false },
      frame.sessionId,
    )) as ProtocolEvaluation;
    if (answer.exceptionDetails !== undefined) throw pageError(answer.exceptionDetails);
    return answer.result?.subtype === "null" ? undefined : answer.result?.objectId;
  };

  const world = async (frameId: string, sessionId: string | undefined): Promise<number> => {
    const created = (await options.send(
      "Page.createIsolatedWorld",
      { frameId, worldName: WORLD_NAME },
      sessionId,
    )) as { readonly executionContextId?: unknown };
    if (typeof created.executionContextId !== "number") {
      throw new Error("Browser frame could not be read.");
    }
    return created.executionContextId;
  };

  /** The frames on other sites a session's page holds, each its own target. */
  const attachedFrames = async (sessionId: string | undefined) => {
    const key = sessionId ?? "";
    let asked = options.targets.autoAttached.get(key);
    if (asked === undefined) {
      // Bounded, and forgotten on failure, so a dead session neither holds the
      // action nor refuses every later frame of the attachment.
      asked = Promise.race([
        options
          .send(
            "Target.setAutoAttach",
            { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
            sessionId,
          )
          .then(() => undefined),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("Browser frame did not answer.")), 2_000),
        ),
      ]);
      options.targets.autoAttached.set(key, asked);
      asked.catch(() => options.targets.autoAttached.delete(key));
    }
    await asked;
    return options.targets.frames;
  };

  return Object.freeze({
    evaluate,
    objectId,
    top: async (): Promise<SurfaceFrame> => {
      const tree = (await options.send("Page.getFrameTree")) as ProtocolFrameTree;
      const frame = tree.frameTree?.frame;
      if (typeof frame?.id !== "string") throw new Error("Browser page has no document.");
      return {
        contextId: await world(frame.id, undefined),
        url: typeof frame.url === "string" ? frame.url : "",
        offset: { x: 0, y: 0, scaleX: 1, scaleY: 1 },
      };
    },
    /** The frame a frame element in `parent` holds, when the agent may enter it. */
    child: async (parent: SurfaceFrame, selector: string): Promise<SurfaceFrameChild> => {
      const owner = await objectId(
        parent,
        `(${resolveBrowserElement.toString()})(${JSON.stringify(selector)})`,
      );
      if (owner === undefined) return { status: "excluded" };
      const described = (await options.send(
        "DOM.describeNode",
        { objectId: owner },
        parent.sessionId,
      )) as { readonly node?: { readonly frameId?: unknown } };
      const frameId = described.node?.frameId;
      if (typeof frameId !== "string") return { status: "excluded" };
      const tree = (await options.send(
        "Page.getFrameTree",
        undefined,
        parent.sessionId,
      )) as ProtocolFrameTree;
      const local = findFrame(tree.frameTree, frameId);
      const remote =
        local === undefined ? (await attachedFrames(parent.sessionId)).get(frameId) : undefined;
      if (local === undefined && remote === undefined) return { status: "excluded" };
      const sessionId = local === undefined ? remote?.sessionId : parent.sessionId;
      const contextId = await world(frameId, sessionId);
      // The address the frame's own document reports now, not one recorded
      // when the frame was announced: a frame can load another site later.
      const reported = await evaluate(
        {
          ...(sessionId === undefined ? {} : { sessionId }),
          contextId,
          url: "",
          offset: parent.offset,
        },
        "location.href",
      );
      const url = typeof reported === "string" ? reported : "";
      // A blank frame shares its parent's origin only in its parent's
      // process; one in a process of its own is another site's.
      if (local === undefined && url.startsWith("about:")) return { status: "excluded" };
      if (!options.admits(url)) return { status: "excluded", ...originOf(url) };
      const offset = (await evaluate(
        parent,
        `(${browserFrameContentOffset.toString()})((${resolveBrowserElement.toString()})(${JSON.stringify(selector)}))`,
      )) as {
        readonly x?: unknown;
        readonly y?: unknown;
        readonly scaleX?: unknown;
        readonly scaleY?: unknown;
      } | null;
      if (
        typeof offset?.x !== "number" ||
        typeof offset.y !== "number" ||
        typeof offset.scaleX !== "number" ||
        typeof offset.scaleY !== "number"
      ) {
        return { status: "excluded" };
      }
      return {
        status: "included",
        frame: {
          ...(sessionId === undefined ? {} : { sessionId }),
          contextId,
          url,
          offset: {
            x: parent.offset.x + parent.offset.scaleX * offset.x,
            y: parent.offset.y + parent.offset.scaleY * offset.y,
            scaleX: parent.offset.scaleX * offset.scaleX,
            scaleY: parent.offset.scaleY * offset.scaleY,
          },
        },
      };
    },
  });
}

export type SurfaceFrames = ReturnType<typeof surfaceFrames>;

export interface AttachedFrame {
  readonly sessionId: string;
  readonly url: string;
}

interface ProtocolEvaluation {
  readonly result?: {
    readonly value?: unknown;
    readonly objectId?: string;
    readonly subtype?: string;
  };
  readonly exceptionDetails?: {
    readonly text?: string;
    readonly exception?: { readonly description?: string };
  };
}

interface ProtocolFrameTree {
  readonly frameTree?: ProtocolFrameNode;
}

interface ProtocolFrameNode {
  readonly frame?: { readonly id?: unknown; readonly url?: unknown };
  readonly childFrames?: ReadonlyArray<ProtocolFrameNode>;
}

function findFrame(
  node: ProtocolFrameNode | undefined,
  frameId: string,
): { readonly url: string } | undefined {
  if (node === undefined) return undefined;
  if (node.frame?.id === frameId) {
    return { url: typeof node.frame.url === "string" ? node.frame.url : "" };
  }
  for (const child of node.childFrames ?? []) {
    const found = findFrame(child, frameId);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * The page code's own refusal, as the message it threw: a refusal such as
 * "Octant will not type into a sensitive or credential field." must read the
 * same from a frame as from the top page.
 */
function pageError(details: NonNullable<ProtocolEvaluation["exceptionDetails"]>): Error {
  const description = details.exception?.description ?? details.text ?? "";
  const first = description.split("\n")[0] ?? "";
  return new Error(first.replace(/^\w*Error: /, "") || "Browser frame script failed.");
}

function originOf(url: string): { readonly origin?: string } {
  try {
    const origin = new URL(url).origin;
    return origin === "null" ? {} : { origin };
  } catch {
    return {};
  }
}
