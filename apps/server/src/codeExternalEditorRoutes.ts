import { timingSafeEqual } from "node:crypto";
import type { CodeCheckoutIdentity, CodeFileReference, CodeThread } from "@octant/contracts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface TargetRequest {
  readonly windowId: string;
  readonly threadId: string;
  readonly checkoutId: string;
  readonly fileId: string;
}

interface CheckoutTargetRequest {
  readonly windowId: string;
  readonly threadId: string;
}

export function isCodeCheckoutOpenTargetCurrent(input: {
  readonly thread: Pick<CodeThread, "checkoutId" | "lifecycle">;
  readonly checkout: Pick<CodeCheckoutIdentity, "id" | "availability">;
}): boolean {
  return (
    input.thread.lifecycle === "active" &&
    input.checkout.availability === "available" &&
    String(input.thread.checkoutId) === String(input.checkout.id)
  );
}

export function isCodeExternalEditorTargetCurrent(input: {
  readonly thread: Pick<CodeThread, "id" | "checkoutId" | "lifecycle">;
  readonly checkout: Pick<CodeCheckoutIdentity, "id" | "availability">;
  readonly reference: Pick<
    CodeFileReference,
    "id" | "threadId" | "checkoutId" | "relativePath" | "state"
  >;
}): boolean {
  const { thread, checkout, reference } = input;
  return (
    thread.lifecycle === "active" &&
    checkout.availability === "available" &&
    String(thread.checkoutId) === String(checkout.id) &&
    String(reference.threadId) === String(thread.id) &&
    String(reference.checkoutId) === String(checkout.id) &&
    reference.relativePath !== undefined &&
    (reference.state === "available" ||
      reference.state === "read-only" ||
      reference.state === "completed")
  );
}

export function createCodeExternalEditorRouteHandler(options: {
  readonly desktopBridgeSecret: string | undefined;
  readonly resolve: (input: TargetRequest) => Promise<
    | {
        readonly file: string;
        readonly editor: { readonly executable: string; readonly arguments: ReadonlyArray<string> };
      }
    | undefined
  >;
}) {
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== "/api/desktop/code-external-editor-target") return undefined;
    if (
      options.desktopBridgeSecret === undefined ||
      url.hostname !== "127.0.0.1" ||
      request.headers.has("origin") ||
      !equal(options.desktopBridgeSecret, request.headers.get("x-octant-desktop-secret") ?? "")
    )
      return failure("unauthorized", 401);
    if (request.method !== "POST" || url.search !== "") return failure("invalid", 400);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return failure("invalid", 400);
    }
    if (
      !record(body) ||
      !exact(body, ["windowId", "threadId", "checkoutId", "fileId", "line", "column"])
    ) {
      return failure("invalid", 400);
    }
    for (const key of ["windowId", "threadId", "checkoutId", "fileId"] as const) {
      if (typeof body[key] !== "string" || !UUID.test(body[key])) return failure("invalid", 400);
    }
    if (!positive(body.line) || !positive(body.column)) return failure("invalid", 400);

    let target:
      | {
          readonly file: string;
          readonly editor: {
            readonly executable: string;
            readonly arguments: ReadonlyArray<string>;
          };
        }
      | undefined;
    try {
      target = await options.resolve({
        windowId: body.windowId as string,
        threadId: body.threadId as string,
        checkoutId: body.checkoutId as string,
        fileId: body.fileId as string,
      });
    } catch {
      return failure("unavailable", 503);
    }
    if (target === undefined) return failure("unavailable", 404);
    return Response.json({ ...target, line: body.line, column: body.column });
  };
}

export function createCodeCheckoutOpenRouteHandler(options: {
  readonly desktopBridgeSecret: string | undefined;
  readonly resolve: (
    input: CheckoutTargetRequest,
  ) => Promise<{ readonly checkoutRoot: string } | undefined>;
}) {
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== "/api/desktop/code-checkout-open-target") return undefined;
    if (
      options.desktopBridgeSecret === undefined ||
      url.hostname !== "127.0.0.1" ||
      request.headers.has("origin") ||
      !equal(options.desktopBridgeSecret, request.headers.get("x-octant-desktop-secret") ?? "")
    ) {
      return failure("unauthorized", 401);
    }
    if (request.method !== "POST" || url.search !== "") return failure("invalid", 400);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return failure("invalid", 400);
    }
    if (!record(body) || !exact(body, ["windowId", "threadId"])) return failure("invalid", 400);
    for (const key of ["windowId", "threadId"] as const) {
      if (typeof body[key] !== "string" || !UUID.test(body[key])) return failure("invalid", 400);
    }
    try {
      const target = await options.resolve({
        windowId: body.windowId as string,
        threadId: body.threadId as string,
      });
      return target === undefined
        ? failure("unavailable", 404)
        : Response.json({ checkoutRoot: target.checkoutRoot });
    } catch {
      return failure("unavailable", 503);
    }
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}
function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function failure(category: string, status: number): Response {
  return Response.json(
    { category, message: "Code external editor target is unavailable." },
    { status },
  );
}
