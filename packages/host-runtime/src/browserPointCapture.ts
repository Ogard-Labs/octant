import {
  MAX_PRODUCT_FEEDBACK_CROP_CHARACTERS,
  decodeProductFeedbackElement,
  type ProductFeedbackElement,
} from "@octant/contracts/product-feedback";
import { redactedBrowserUrl, readBrowserFeedbackElement } from "@octant/domain";

export type BrowserFeedbackPointObservation =
  | {
      readonly status: "described";
      readonly element: Omit<
        Extract<ProductFeedbackElement, { readonly kind: "browser-element" }>,
        "kind" | "url" | "title"
      >;
      readonly cropDataUrl?: string;
      readonly url?: string;
      readonly title?: string;
    }
  | { readonly status: "no-element" }
  | {
      readonly status: "unavailable";
      readonly reason:
        | "page-changed"
        | "observation-paused"
        | "frame-unavailable"
        | "capture-unavailable";
    };

export interface BrowserFeedbackCapturePort {
  readonly send: (method: string, parameters?: Record<string, unknown>) => Promise<unknown>;
  /** Host-owned context/tab/document/person-input/current-authority proof. */
  readonly current: () => boolean;
  readonly admits: (url: string) => boolean;
  /** Reuse the runtime's existing all-frame credential/observation pause. */
  readonly sensitive: () => Promise<boolean>;
  readonly digest: (value: string) => string;
}

/**
 * One bounded read sequence on an already-authorized page. The caller owns the
 * finite read deadline and context lifetime; every protocol wait settles on its
 * signal even when a port ignores cancellation. No child-frame traversal.
 */
export async function captureBrowserFeedbackPoint(
  port: BrowserFeedbackCapturePort,
  point: { readonly x: number; readonly y: number },
  signal: AbortSignal,
): Promise<BrowserFeedbackPointObservation> {
  let refusal: Extract<BrowserFeedbackPointObservation, { status: "unavailable" }>["reason"] =
    "capture-unavailable";
  const check = () => {
    if (signal.aborted || !port.current()) {
      refusal = "page-changed";
      throw new Error("Feedback capture retired.");
    }
  };
  const wait = async <T>(effect: Promise<T>): Promise<T> => {
    check();
    const result = await abortable(effect, signal);
    check();
    return result;
  };
  const send = (method: string, parameters?: Record<string, unknown>) => {
    check();
    return wait(port.send(method, parameters));
  };
  const pause = async () => {
    check();
    if (await wait(port.sensitive())) {
      refusal = "observation-paused";
      throw new Error("Feedback observation paused.");
    }
  };
  const read = async () => {
    const tree = record(await send("Page.getFrameTree"));
    const frame = record(record(tree?.frameTree)?.frame);
    if (
      frame === undefined ||
      typeof frame.id !== "string" ||
      typeof frame.loaderId !== "string" ||
      typeof frame.url !== "string" ||
      !port.admits(frame.url)
    ) {
      refusal = "frame-unavailable";
      throw new Error("Feedback frame is unavailable.");
    }
    const metrics = record(await send("Page.getLayoutMetrics"));
    const viewport = record(metrics?.cssVisualViewport);
    if (
      viewport === undefined ||
      !dimension(viewport.clientWidth) ||
      !dimension(viewport.clientHeight) ||
      typeof viewport.pageX !== "number" ||
      !Number.isFinite(viewport.pageX) ||
      typeof viewport.pageY !== "number" ||
      !Number.isFinite(viewport.pageY) ||
      viewport.scale !== 1 ||
      (viewport.offsetX !== undefined && viewport.offsetX !== 0) ||
      (viewport.offsetY !== undefined && viewport.offsetY !== 0)
    ) {
      throw new Error("Feedback viewport is unavailable.");
    }
    const argument = {
      x: point.x * viewport.clientWidth,
      y: point.y * viewport.clientHeight,
      viewportWidth: viewport.clientWidth,
      viewportHeight: viewport.clientHeight,
      pageX: viewport.pageX,
      pageY: viewport.pageY,
    };
    const hit = record(
      await send("DOM.getNodeForLocation", {
        x: Math.floor(argument.x),
        y: Math.floor(argument.y),
        includeUserAgentShadowDOM: false,
        ignorePointerEventsNone: false,
      }),
    );
    if (
      hit?.frameId !== frame.id ||
      typeof hit.backendNodeId !== "number" ||
      !Number.isInteger(hit.backendNodeId) ||
      hit.backendNodeId <= 0
    ) {
      refusal = "frame-unavailable";
      throw new Error("Feedback frame is unavailable.");
    }
    const world = record(
      await send("Page.createIsolatedWorld", {
        frameId: frame.id,
        worldName: "octant-element-feedback",
        grantUniveralAccess: false,
      }),
    );
    if (typeof world?.executionContextId !== "number")
      throw new Error("Feedback world is unavailable.");
    const response = record(
      await send("Runtime.evaluate", {
        contextId: world.executionContextId,
        returnByValue: true,
        awaitPromise: false,
        expression: `({ read: (${readBrowserFeedbackElement.toString()})(${JSON.stringify(argument)}), title: document.title.slice(0, 1024) })`,
      }),
    );
    if (response?.exceptionDetails !== undefined)
      throw new Error("Feedback element is unavailable.");
    const result = record(record(response?.result)?.value);
    const description = record(result?.read);
    if (result === undefined || description === undefined) return undefined;
    const element = record(description.element);
    const context = record(description.context);
    if (
      element === undefined ||
      context === undefined ||
      typeof description.cropBlocked !== "boolean"
    ) {
      throw new Error("Feedback description is invalid.");
    }
    const crop = record(description.cropBounds);
    if (
      crop === undefined ||
      typeof crop.x !== "number" ||
      typeof crop.y !== "number" ||
      typeof crop.width !== "number" ||
      typeof crop.height !== "number" ||
      !Number.isFinite(crop.x) ||
      !Number.isFinite(crop.y) ||
      !Number.isFinite(crop.width) ||
      !Number.isFinite(crop.height) ||
      crop.x < viewport.pageX ||
      crop.y < viewport.pageY ||
      crop.width < 0 ||
      crop.height < 0 ||
      crop.x + crop.width > viewport.pageX + viewport.clientWidth ||
      crop.y + crop.height > viewport.pageY + viewport.clientHeight
    )
      throw new Error("Feedback crop is invalid.");
    // Closed descendants can overflow an ordinary host's box. A native presence
    // check therefore withholds the whole optional crop, not only the host bounds.
    const opaqueShadow = !(await hasCompleteShadowCoverage(send));
    const decoded = decodeProductFeedbackElement({
      kind: "browser-element",
      ...element,
      context: { ...context, captureId: "0".repeat(64) },
    });
    if (decoded.kind !== "browser-element" || decoded.context === undefined) {
      throw new Error("Feedback description is invalid.");
    }
    const { kind: _kind, ...original } = decoded;
    const selected =
      opaqueShadow && !decoded.context.omissions.includes("crop-withheld-for-uninspected-region")
        ? {
            ...original,
            context: {
              ...decoded.context,
              omissions: [
                ...decoded.context.omissions,
                "crop-withheld-for-uninspected-region" as const,
              ],
            },
          }
        : original;
    return {
      frame: { id: frame.id, loaderId: frame.loaderId, url: frame.url },
      hit: hit.backendNodeId,
      viewport: {
        width: viewport.clientWidth,
        height: viewport.clientHeight,
        pageX: viewport.pageX,
        pageY: viewport.pageY,
      },
      element: selected,
      cropBlocked: description.cropBlocked || opaqueShadow,
      cropBounds: { x: crop.x, y: crop.y, width: crop.width, height: crop.height },
      ...(typeof result.title === "string" ? { title: result.title.trim().slice(0, 1_024) } : {}),
    };
  };
  try {
    check();
    if (
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y) ||
      point.x < 0 ||
      point.x >= 1 ||
      point.y < 0 ||
      point.y >= 1
    )
      return { status: "no-element" };
    await pause();
    const before = await read();
    if (before === undefined) return { status: "no-element" };
    await pause();
    let cropDataUrl: string | undefined;
    if (!before.cropBlocked) {
      const { x, y, width, height } = before.cropBounds;
      if (width >= 1 && height >= 1) {
        const screenshot = record(
          await send("Page.captureScreenshot", {
            format: "jpeg",
            quality: 60,
            captureBeyondViewport: false,
            clip: { x, y, width, height, scale: 1 },
          }).catch(() => undefined),
        );
        if (
          typeof screenshot?.data === "string" &&
          screenshot.data.length > 0 &&
          screenshot.data.length + 23 <= MAX_PRODUCT_FEEDBACK_CROP_CHARACTERS &&
          /^[A-Za-z0-9+/]+={0,2}$/.test(screenshot.data)
        ) {
          cropDataUrl = `data:image/jpeg;base64,${screenshot.data}`;
        }
      }
    }
    await pause();
    const after = await read();
    await pause();
    if (after === undefined || JSON.stringify(before) !== JSON.stringify(after)) {
      return { status: "unavailable", reason: "page-changed" };
    }
    check();
    const context = before.element.context;
    if (context === undefined) throw new Error("Feedback context is unavailable.");
    const omissions = [...context.omissions];
    if (before.cropBlocked && !omissions.includes("crop-withheld-for-uninspected-region")) {
      omissions.push("crop-withheld-for-editable-content");
    } else if (cropDataUrl === undefined && !before.cropBlocked) omissions.push("crop-unavailable");
    const captureId = port.digest(JSON.stringify(before));
    check();
    return {
      status: "described",
      element: { ...before.element, context: { ...context, captureId, omissions } },
      ...(cropDataUrl === undefined ? {} : { cropDataUrl }),
      url: redactedBrowserUrl(before.frame.url).slice(0, 4_096),
      ...(before.title === undefined || before.title.length === 0 ? {} : { title: before.title }),
    };
  } catch {
    return { status: "unavailable", reason: signal.aborted ? "page-changed" : refusal };
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function dimension(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 16_384;
}

function abortable<T>(effect: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const interrupted = () => {
      signal.removeEventListener("abort", interrupted);
      reject(new Error("Feedback capture retired."));
    };
    if (signal.aborted) interrupted();
    else signal.addEventListener("abort", interrupted, { once: true });
    effect.then(
      (value) => {
        signal.removeEventListener("abort", interrupted);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", interrupted);
        reject(error);
      },
    );
  });
}

/** Page JavaScript cannot distinguish a closed shadow host from a plain element. */
async function hasCompleteShadowCoverage(
  send: BrowserFeedbackCapturePort["send"],
): Promise<boolean> {
  const tree = record(
    await send("DOM.getDocument", { depth: -1, pierce: true }).catch(() => undefined),
  );
  const root = record(tree?.root);
  if (root === undefined) return false;
  const pending: unknown[] = [root];
  let count = 0;
  while (pending.length > 0) {
    const node = record(pending.pop());
    if (node === undefined || typeof node.nodeName !== "string" || ++count > 20_000) return false;
    const shadows = node.shadowRoots;
    if (shadows !== undefined) {
      if (!Array.isArray(shadows)) return false;
      for (const entry of shadows) {
        const shadow = record(entry);
        if (shadow?.shadowRootType !== "open") return false;
        pending.push(shadow);
      }
    }
    if (node.children !== undefined) {
      if (!Array.isArray(node.children)) return false;
      pending.push(...node.children);
    }
  }
  return true;
}
