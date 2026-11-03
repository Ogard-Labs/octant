import {
  decodeEventActor,
  decodeWindowId,
  decodeProductFeedbackCommandResult,
} from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { ProductFeedbackError, ProductFeedbackService } from "./browser/productFeedbackService";
import { bindPrincipalRouteContext } from "./principalRouteContext";
import { createProductFeedbackRouteHandler } from "./productFeedbackRoutes";
import { WindowAuthorityStore } from "./windowAuthorityStore";
import { productFeedbackPersistenceFixture } from "./browser/productFeedback.test-fixtures";
import { readThreadExternalContentTaint } from "./context/externalContentTaintProjection";

const windowId = decodeWindowId("11111111-1111-4111-8111-111111111111");
const capability = `${"A".repeat(42)}A`;
const threadId = "22222222-2222-4222-8222-222222222222";
const contextId = "33333333-3333-4333-8333-333333333333";

const captureBody = JSON.stringify({
  kind: "capture-product-feedback",
  threadId,
  mode: "code",
  contextId,
  point: { x: 0.5, y: 0.5 },
  comment: "This is misaligned.",
});

function handler(
  overrides: {
    readonly list?: ReturnType<typeof vi.fn>;
    readonly execute?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const store = new WindowAuthorityStore();
  store.register({ windowId, capability, now: 0 });
  const list = overrides.list ?? vi.fn(async () => []);
  const execute = overrides.execute ?? vi.fn(async () => ({ kind: "feedback-captured" }));
  return {
    list,
    execute,
    store,
    handle: createProductFeedbackRouteHandler({
      windowAuthorityStore: store,
      feedback: { list, execute } as never,
      now: () => 0,
    }),
  };
}

describe("pointed-at feedback routes", () => {
  it.each(["native-read", "commit-scope"] as const)(
    "retains original request identity during %s without storing it in a completed preview",
    async (phase) => {
      for (const replacement of ["header", "bound-context"] as const) {
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let hold = false;
        const boundary = async () => {
          if (!hold) return;
          entered.resolve();
          await release.promise;
        };
        const fixture = productFeedbackPersistenceFixture({
          windowId,
          threadId,
          mode: "code",
          current: () => true,
          ...(phase === "native-read"
            ? { beforePointRead: boundary }
            : { beforeScopeRead: boundary }),
        });
        const store = new WindowAuthorityStore();
        store.register({ windowId, capability, now: 0 });
        const serviceResults: string[] = [];
        const handle = createProductFeedbackRouteHandler({
          windowAuthorityStore: store,
          now: () => 0,
          feedback: {
            list: (...args) => fixture.service.list(...args),
            readCropForNote: (...args) => fixture.service.readCropForNote(...args),
            execute: async (...args) => {
              const result = await fixture.service.execute(...args);
              serviceResults.push(result.kind);
              return result;
            },
          },
        });
        const request = (command: unknown, signal?: AbortSignal) => {
          const value = new Request("http://127.0.0.1/api/feedback/commands", {
            method: "POST",
            headers: { "x-octant-window-capability": capability },
            body: JSON.stringify(command),
            ...(signal === undefined ? {} : { signal }),
          });
          bindPrincipalRouteContext(value, {
            scopeId: windowId,
            principal: { kind: "local-window", windowId, capabilityGeneration: 0 },
          });
          return value;
        };
        const prepare = {
          kind: "prepare-product-feedback",
          threadId,
          contextId,
          expectedObservationRevision: 0,
          point: { x: 0.2, y: 0.15 },
        };
        try {
          let command: unknown = prepare;
          let previewId: string | undefined;
          if (phase === "commit-scope") {
            const controller = new AbortController();
            const response = await handle(request(prepare, controller.signal));
            const prepared = decodeProductFeedbackCommandResult(await response?.json());
            if (prepared.kind !== "feedback-prepared") throw Error("Preview unavailable");
            previewId = prepared.preview.id;
            // A completed prepare's transport lifetime is not its preview lifetime.
            controller.abort();
            command = {
              kind: "commit-product-feedback",
              threadId,
              previewId,
              comment: "Preserve my intended comment",
            };
          }
          hold = true;
          const original = request(command);
          const pending = handle(original);
          await entered.promise;
          if (replacement === "header")
            original.headers.set("x-octant-window-capability", "B".repeat(43));
          else
            bindPrincipalRouteContext(original, {
              scopeId: windowId,
              principal: { kind: "local-window", windowId, capabilityGeneration: 0 },
            });
          release.resolve();
          expect((await pending)?.status).toBe(401);
          expect(serviceResults.at(-1)).toBe("feedback-refused");
          expect(
            fixture.connection.prepare("SELECT COUNT(*) AS count FROM event_journal").get(),
          ).toMatchObject({ count: 0 });
          expect(
            fixture.connection
              .prepare("SELECT COUNT(*) AS count FROM code_evidence_content_store")
              .get(),
          ).toMatchObject({ count: 0 });
          expect(
            readThreadExternalContentTaint(fixture.connection, threadId).externalContentIngested,
          ).toBe(false);
          if (previewId !== undefined) {
            hold = false;
            const retried = await handle(request(command));
            expect(retried?.status).toBe(200);
            expect(decodeProductFeedbackCommandResult(await retried?.json()).kind).toBe(
              "feedback-captured",
            );
          }
        } finally {
          release.resolve();
          fixture.close();
        }
      }
    },
  );
  it("answers a thread's notes to the window that authenticated", async () => {
    const { handle, list } = handler();

    const response = await handle(
      new Request(`http://127.0.0.1/api/feedback/notes?threadId=${threadId}`, {
        headers: { "x-octant-window-capability": capability },
      }),
    );

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ notes: [] });
    expect(list).toHaveBeenCalledWith(
      windowId,
      threadId,
      expect.objectContaining({ admissionCurrent: expect.any(Function) }),
    );
  });

  it("refuses a capture that carries no window capability", async () => {
    const { handle, execute } = handler();

    const response = await handle(
      new Request("http://127.0.0.1/api/feedback/commands", {
        method: "POST",
        body: captureBody,
      }),
    );

    expect(response?.status).toBe(401);
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses a capture that did not come from loopback", async () => {
    const { handle, execute } = handler();

    const response = await handle(
      new Request("http://octant.example/api/feedback/commands", {
        method: "POST",
        headers: { "x-octant-window-capability": capability },
        body: captureBody,
      }),
    );

    expect(response?.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it("hands the capture to the service under the authenticated window", async () => {
    const { handle, execute } = handler();

    const response = await handle(
      new Request("http://127.0.0.1/api/feedback/commands", {
        method: "POST",
        headers: { "x-octant-window-capability": capability },
        body: captureBody,
      }),
    );

    expect(response?.status).toBe(200);
    expect(execute).toHaveBeenCalledWith(
      windowId,
      JSON.parse(captureBody),
      expect.objectContaining({ admissionCurrent: expect.any(Function) }),
    );
  });

  it.each(["body", "native-read"] as const)(
    "fences an actual feedback service when the bound original capability retires during %s",
    async (phase) => {
      const store = new WindowAuthorityStore();
      store.register({ windowId, capability, now: 0 });
      let observing = false;
      let release: (() => void) | undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const describePoint = vi.fn(async () => {
        observing = true;
        if (phase === "native-read") await held;
        return {
          status: "described" as const,
          element: { selector: "button", bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 } },
        };
      });
      const append = vi.fn();
      const put = vi.fn(() => ({ contentId: contextId, digest: "a".repeat(64), byteLength: 1 }));
      const service = new ProductFeedbackService({
        journal: { append },
        browser: { describePoint },
        crops: { put, read: () => undefined },
        readNote: () => undefined,
        readNotes: () => [],
        canAccessThread: async () => true,
        resolveThread: async () => ({ mode: "code", current: () => true }),
        uuid: () => contextId,
        clock: () => "2026-11-03T10:00:00.000Z",
        actor: decodeEventActor({
          kind: "local-user",
          actorId: "55555555-5555-4555-8555-555555555555",
        }),
      });
      const handle = createProductFeedbackRouteHandler({
        feedback: service,
        windowAuthorityStore: store,
        now: () => 0,
      });
      let body: ReadableStreamDefaultController<Uint8Array> | undefined;
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          body = controller;
        },
      });
      const init: RequestInit & { duplex: "half" } = {
        method: "POST",
        headers: { "content-type": "application/json", "x-octant-window-capability": capability },
        body: stream,
        duplex: "half",
      };
      const request = new Request("http://127.0.0.1/api/feedback/commands", init);
      bindPrincipalRouteContext(request, {
        scopeId: windowId,
        principal: { kind: "local-window", windowId, capabilityGeneration: 0 },
      });
      const encoded = new TextEncoder().encode(
        JSON.stringify({
          kind: "prepare-product-feedback",
          threadId,
          contextId,
          expectedObservationRevision: 0,
          point: { x: 0.2, y: 0.15 },
        }),
      );
      try {
        const response = handle(request);
        if (phase === "body") store.revoke(windowId);
        body?.enqueue(encoded);
        body?.close();
        if (phase === "native-read") {
          await vi.waitFor(() => expect(observing).toBe(true));
          store.revoke(windowId);
          release?.();
        }
        expect((await response)?.status).toBe(401);
        expect(describePoint).toHaveBeenCalledTimes(phase === "body" ? 0 : 1);
        expect(put).not.toHaveBeenCalled();
        expect(append).not.toHaveBeenCalled();
      } finally {
        release?.();
        service.close();
      }
    },
  );

  it("reports a note that moved under the caller as a conflict", async () => {
    const { handle } = handler({
      execute: vi.fn(async () => {
        throw new ProductFeedbackError("conflict", "Product feedback note has changed.");
      }),
    });

    const response = await handle(
      new Request("http://127.0.0.1/api/feedback/commands", {
        method: "POST",
        headers: { "x-octant-window-capability": capability },
        body: captureBody,
      }),
    );

    expect(response?.status).toBe(409);
  });

  it("leaves paths it does not own to the rest of the server", async () => {
    const { handle } = handler();

    expect(await handle(new Request("http://127.0.0.1/api/browser/scope"))).toBeUndefined();
  });
});
