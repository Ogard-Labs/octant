import { randomBytes } from "node:crypto";
import { decodeWindowId, type WindowId } from "@octant/contracts";
import { NIGHTLY_HOST_FEATURES } from "@octant/contracts/nightly-browser";
import { describe, expect, it, vi } from "vitest";
import { BindingReceiptStore } from "./bindingReceiptStore";
import {
  createCodeCheckoutOpenRouteHandler,
  createCodeExternalEditorRouteHandler,
} from "./codeExternalEditorRoutes";
import { createCodeOperationApprovalRouteHandler } from "./codeOperationApprovalRoutes";
import {
  admitDesktopBroker,
  NATIVE_MAIN_ADMITTED_ROUTES,
  NATIVE_MAIN_AUTHORITY_HEADER,
  NATIVE_MAIN_HOST_FEATURES,
} from "./desktopBrokerAdmission";
import { createExtensionRouteHandler } from "./extensionRoutes";
import { LocalPluginImportReceiptStore } from "./extensions/localPluginImportReceiptStore";
import { createPreviewHandoffBridgeRouteHandler } from "./previewHandoffRoutes";
import { bindPrincipalRouteContext } from "./principalRouteContext";
import { createProjectBindingRouteHandler } from "./projectBindingRoutes";
import { createDiscoveryRouteHandler } from "./providers/discoveryRoutes";
import { createProviderCredentialRouteHandler } from "./providers/providerCredentialRoutes";
import { createSupportBundleRouteHandler } from "./supportBundleRoutes";
import { WindowAuthorityStore } from "./windowAuthorityStore";

const secret = randomBytes(32).toString("base64url");
const token = () => randomBytes(32).toString("base64url");
const windowA = decodeWindowId("10000000-0000-4000-8000-0000000006a1");
const windowB = decodeWindowId("10000000-0000-4000-8000-0000000006b2");
const localWindow = decodeWindowId("10000000-0000-4000-8000-0000000006c3");

interface NativeWindow {
  readonly windowId: WindowId;
  readonly capability: string;
  readonly rendererIdentity: string;
  readonly nativeMainToken: string;
  readonly source: {
    readonly kind: "native-nightly";
    readonly processRegistration: string;
    readonly incarnation: string;
    readonly generation: number;
  };
}

function fixture() {
  let elapsed = 0;
  const store = new WindowAuthorityStore(undefined, {
    elapsedNow: () => elapsed,
    schedule: () => () => {},
  });
  const native = (windowId: WindowId): NativeWindow => {
    const window = {
      windowId,
      capability: token(),
      rendererIdentity: token(),
      nativeMainToken: token(),
      source: {
        kind: "native-nightly" as const,
        processRegistration: token(),
        incarnation: "5".repeat(64),
        generation: 1,
      },
    };
    store.registerNative({ ...window, now: 1_000 });
    return window;
  };
  const a = native(windowA);
  const b = native(windowB);
  const local = { capability: token(), rendererIdentity: token() };
  store.register({ windowId: localWindow, ...local, now: 1_000 });
  return {
    store,
    a,
    b,
    local,
    advance: (value: number) => {
      elapsed = value;
    },
  };
}

function nativeRequest(
  path: string,
  body: unknown,
  headers: Readonly<Record<string, string>>,
): Request {
  return new Request(`http://127.0.0.1:13773${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function mainHeaders(window: { readonly capability: string; readonly nativeMainToken: string }) {
  return {
    "x-octant-window-capability": window.capability,
    [NATIVE_MAIN_AUTHORITY_HEADER]: window.nativeMainToken,
  };
}

function projectRoutes(store: WindowAuthorityStore) {
  const validate = vi.fn(async () => ({ canonicalRoot: "/canonical/project" }));
  return {
    validate,
    handle: createProjectBindingRouteHandler({
      desktopBridgeSecret: secret,
      windowAuthorityStore: store,
      bindingReceiptStore: new BindingReceiptStore(),
      projectRootPort: { validate },
      now: () => 1_000,
    }),
  };
}

const receiptBody = { windowId: windowA, projectType: "work", path: "/picked/root" };

describe("Native main admission to brokered host routes", () => {
  it("admits a native main only on the closed list of brokered routes", () => {
    expect(NATIVE_MAIN_ADMITTED_ROUTES).toEqual([
      "/api/desktop/project-binding-receipts",
      "/api/extensions/import-local-receipts",
      "/api/providers/discovery/binary-receipts",
      "/api/desktop/code-external-editor-target",
      "/api/desktop/code-checkout-open-target",
      "/api/desktop/preview-handoff",
      "/api/diagnostics/bundle/save",
      "/api/desktop/code-operation-approval-challenges",
      "/api/desktop/code-operation-approval-confirmations",
      "/api/desktop/code-operation-approval-cancellations",
      "/api/desktop/provider-credentials/status",
      "/api/desktop/provider-credentials/set",
      "/api/desktop/provider-credentials/remove",
    ]);
    expect(NATIVE_MAIN_HOST_FEATURES).toEqual(NIGHTLY_HOST_FEATURES);
  });

  it("keeps administrative routes on Stable's bridge secret even with a valid token", () => {
    const f = fixture();
    for (const path of [
      "/api/desktop/hub/status",
      "/api/desktop/hub/paired-merge-unlock",
      "/api/desktop/private-listener/enable",
      "/api/desktop/private-listener/host-identity-fingerprint",
      "/api/desktop/remote/pairing-tickets",
      "/api/desktop/remote/devices/revoke-all",
      "/api/desktop/launch-sessions",
      "/api/desktop/window-authorities",
      "/api/desktop/native-window-authorities",
      "/api/desktop/provider-credentials/remove-provider",
      "/api/desktop/provider-sign-in/begin",
    ]) {
      expect(
        admitDesktopBroker({
          request: nativeRequest(path, {}, mainHeaders(f.a)),
          desktopBridgeSecret: secret,
          windowAuthorityStore: f.store,
          now: 1_000,
        }),
      ).toEqual({ status: "refused" });
    }
  });

  it("refuses window registration and provider removal routes for a native main", async () => {
    const f = fixture();
    const { handle } = projectRoutes(f.store);
    for (const path of [
      "/api/desktop/window-authorities",
      "/api/desktop/native-window-authorities",
    ])
      expect((await handle(nativeRequest(path, {}, mainHeaders(f.a))))?.status).toBe(401);
    const credentials = createProviderCredentialRouteHandler({
      desktopBridgeSecret: secret,
      windowAuthorityStore: f.store,
      readProviderInstances: () => [],
      readRemovedProviderInstanceIds: () => [],
      credentials: undefined,
      journal: {} as never,
      reprobe: vi.fn(),
      removeProvider: vi.fn(),
      now: () => 1_000,
    });
    expect(
      (
        await credentials(
          nativeRequest(
            "/api/desktop/provider-credentials/remove-provider",
            { instance: "openai" },
            mainHeaders(f.a),
          ),
        )
      )?.status,
    ).toBe(401);
  });

  it("refuses a missing token, a renderer token, and a request that carries a renderer origin", async () => {
    const f = fixture();
    const { handle, validate } = projectRoutes(f.store);
    const capability = { "x-octant-window-capability": f.a.capability };
    for (const headers of [
      capability,
      { ...capability, [NATIVE_MAIN_AUTHORITY_HEADER]: "" },
      { ...capability, [NATIVE_MAIN_AUTHORITY_HEADER]: f.a.rendererIdentity },
      { ...capability, [NATIVE_MAIN_AUTHORITY_HEADER]: f.a.capability },
      { ...mainHeaders(f.a), origin: "file://" },
      { ...mainHeaders(f.a), "x-octant-desktop-secret": "wrong" },
    ]) {
      expect(
        (await handle(nativeRequest("/api/desktop/project-binding-receipts", receiptBody, headers)))
          ?.status,
      ).toBe(401);
    }
    expect(validate).not.toHaveBeenCalled();
  });

  it("refuses an ordinary local window, which never holds a native main token", async () => {
    const f = fixture();
    const { handle } = projectRoutes(f.store);
    const response = await handle(
      nativeRequest(
        "/api/desktop/project-binding-receipts",
        { ...receiptBody, windowId: localWindow },
        {
          "x-octant-window-capability": f.local.capability,
          [NATIVE_MAIN_AUTHORITY_HEADER]: f.local.rendererIdentity,
        },
      ),
    );
    expect(response?.status).toBe(401);
  });

  it("refuses a token after its lease expires or is revoked", async () => {
    const expired = fixture();
    expired.advance(15_000);
    expect(
      (
        await projectRoutes(expired.store).handle(
          nativeRequest(
            "/api/desktop/project-binding-receipts",
            receiptBody,
            mainHeaders(expired.a),
          ),
        )
      )?.status,
    ).toBe(401);

    const revoked = fixture();
    revoked.store.revokeNative(revoked.a);
    expect(
      (
        await projectRoutes(revoked.store).handle(
          nativeRequest(
            "/api/desktop/project-binding-receipts",
            receiptBody,
            mainHeaders(revoked.a),
          ),
        )
      )?.status,
    ).toBe(401);
  });

  it("refuses another window's token, capability, or named window", async () => {
    const f = fixture();
    const { handle, validate } = projectRoutes(f.store);
    for (const [body, headers] of [
      [receiptBody, { ...mainHeaders(f.a), "x-octant-window-capability": f.b.capability }],
      [receiptBody, { ...mainHeaders(f.a), [NATIVE_MAIN_AUTHORITY_HEADER]: f.b.nativeMainToken }],
      [{ ...receiptBody, windowId: windowB }, mainHeaders(f.a)],
    ] as const) {
      expect(
        (await handle(nativeRequest("/api/desktop/project-binding-receipts", body, headers)))
          ?.status,
      ).toBe(401);
    }
    expect(validate).not.toHaveBeenCalled();
  });

  it("refuses a request forwarded from the remote listener", async () => {
    const f = fixture();
    const request = nativeRequest(
      "/api/desktop/project-binding-receipts",
      receiptBody,
      mainHeaders(f.a),
    );
    bindPrincipalRouteContext(request, {
      principal: { kind: "remote-device" } as never,
      scopeId: windowA,
    });
    expect((await projectRoutes(f.store).handle(request))?.status).toBe(401);
  });

  it("still admits Stable's main by its bridge secret for any window", async () => {
    const f = fixture();
    const { handle } = projectRoutes(f.store);
    const response = await handle(
      nativeRequest(
        "/api/desktop/project-binding-receipts",
        { ...receiptBody, windowId: windowB },
        { "x-octant-desktop-secret": secret },
      ),
    );
    expect(response?.status).toBe(201);
  });

  describe("admits a native main for its own window on each brokered route", () => {
    it("trades a picked Project root for a receipt", async () => {
      const f = fixture();
      const { handle, validate } = projectRoutes(f.store);
      const response = await handle(
        nativeRequest("/api/desktop/project-binding-receipts", receiptBody, mainHeaders(f.a)),
      );
      expect(response?.status).toBe(201);
      expect(validate).toHaveBeenCalledWith("work", "/picked/root");
    });

    it("trades a picked plugin or skill folder for a receipt", async () => {
      const f = fixture();
      const handle = createExtensionRouteHandler({
        service: {} as never,
        windowAuthorityStore: f.store,
        desktopBridgeSecret: secret,
        localPluginImportReceipts: new LocalPluginImportReceiptStore(),
        now: () => 1_000,
      });
      for (const body of [
        { windowId: windowA, absolutePath: "/picked/plugin" },
        { windowId: windowA, absolutePath: "/picked/skills", purpose: "skill-folder" },
      ]) {
        const response = await handle(
          nativeRequest("/api/extensions/import-local-receipts", body, mainHeaders(f.a)),
        );
        expect(response?.status).toBe(201);
      }
      expect(
        (
          await handle(
            nativeRequest(
              "/api/extensions/import-local-receipts",
              { windowId: windowB, absolutePath: "/picked/plugin" },
              mainHeaders(f.a),
            ),
          )
        )?.status,
      ).toBe(401);
    });

    it("trades a picked runtime binary for a receipt", async () => {
      const f = fixture();
      const handle = createDiscoveryRouteHandler({
        discoveryService: {} as never,
        windowAuthorityStore: f.store,
        desktopBridgeSecret: secret,
        binaryReceipts: new LocalPluginImportReceiptStore(),
        now: () => 1_000,
      });
      const path = "/api/providers/discovery/binary-receipts";
      expect(
        (
          await handle(
            nativeRequest(path, { windowId: windowA, absolutePath: "/bin/tool" }, mainHeaders(f.a)),
          )
        )?.status,
      ).toBe(201);
      expect(
        (
          await handle(
            nativeRequest(path, { windowId: windowB, absolutePath: "/bin/tool" }, mainHeaders(f.a)),
          )
        )?.status,
      ).toBe(401);
    });

    it("resolves an external editor and checkout open target", async () => {
      const f = fixture();
      const resolveEditor = vi.fn(async () => ({
        file: "/checkout/file.ts",
        editor: { executable: "/usr/bin/editor", arguments: [] },
      }));
      const editor = createCodeExternalEditorRouteHandler({
        desktopBridgeSecret: secret,
        windowAuthorityStore: f.store,
        now: () => 1_000,
        resolve: resolveEditor,
      });
      const ids = {
        threadId: "20000000-0000-4000-8000-000000000001",
        checkoutId: "30000000-0000-4000-8000-000000000001",
        fileId: "40000000-0000-4000-8000-000000000001",
      };
      const editorPath = "/api/desktop/code-external-editor-target";
      expect(
        (
          await editor(
            nativeRequest(
              editorPath,
              { windowId: windowA, ...ids, line: 1, column: 1 },
              mainHeaders(f.a),
            ),
          )
        )?.status,
      ).toBe(200);
      expect(
        (
          await editor(
            nativeRequest(
              editorPath,
              { windowId: windowB, ...ids, line: 1, column: 1 },
              mainHeaders(f.a),
            ),
          )
        )?.status,
      ).toBe(401);
      expect(resolveEditor).toHaveBeenCalledTimes(1);

      const resolveCheckout = vi.fn(async () => ({ checkoutRoot: "/checkout" }));
      const checkout = createCodeCheckoutOpenRouteHandler({
        desktopBridgeSecret: secret,
        windowAuthorityStore: f.store,
        now: () => 1_000,
        resolve: resolveCheckout,
      });
      const checkoutPath = "/api/desktop/code-checkout-open-target";
      expect(
        (
          await checkout(
            nativeRequest(
              checkoutPath,
              { windowId: windowA, threadId: ids.threadId },
              mainHeaders(f.a),
            ),
          )
        )?.status,
      ).toBe(200);
      expect(
        (
          await checkout(
            nativeRequest(
              checkoutPath,
              { windowId: windowB, threadId: ids.threadId },
              mainHeaders(f.a),
            ),
          )
        )?.status,
      ).toBe(401);
      expect(resolveCheckout).toHaveBeenCalledTimes(1);
    });

    it("resolves a preview handoff", async () => {
      const f = fixture();
      const resolve = vi.fn(async () => ({
        kind: "resolved" as const,
        handoffKind: "open-external" as const,
        absolutePath: "/exports/notes.md",
        displayName: "notes.md",
      }));
      const handle = createPreviewHandoffBridgeRouteHandler({
        desktopBridgeSecret: secret,
        windowAuthorityStore: f.store,
        now: () => 1_000,
        resolve,
      });
      const target = {
        targetId: "11111111-1111-4111-8111-111111111111",
        projectId: "22222222-2222-4222-8222-222222222222",
        hostId: "33333333-3333-4333-8333-333333333333",
        kind: "file",
        opaqueRef: "opaque-token-1",
        displayName: "notes.md",
      };
      for (const [windowId, status] of [
        [windowA, 200],
        [windowB, 401],
      ] as const) {
        expect(
          (
            await handle(
              nativeRequest(
                "/api/desktop/preview-handoff",
                { windowId, target, kind: "open-external" },
                mainHeaders(f.a),
              ),
            )
          )?.status,
        ).toBe(status);
      }
      expect(resolve).toHaveBeenCalledTimes(1);
    });

    it("reaches the support bundle save request check", async () => {
      const f = fixture();
      const sources = vi.fn();
      const handle = createSupportBundleRouteHandler({
        windowAuthorityStore: f.store,
        desktopBridgeSecret: secret,
        now: () => 1_000,
        sources,
      });
      const save = (headers: Readonly<Record<string, string>>) =>
        handle(
          nativeRequest("/api/diagnostics/bundle/save", { absolutePath: "relative" }, headers),
        );
      // Past admission, the relative path is refused as invalid rather than unauthorized.
      expect((await save(mainHeaders(f.a)))?.status).toBe(400);
      expect((await save({ "x-octant-window-capability": f.a.capability }))?.status).toBe(401);
    });

    it("prepares, confirms and cancels a Code operation approval", async () => {
      const f = fixture();
      const prepare = vi.fn(async () => undefined);
      const confirm = vi.fn(async () => undefined);
      const cancel = vi.fn();
      const handle = createCodeOperationApprovalRouteHandler({
        desktopBridgeSecret: secret,
        windowAuthorityStore: f.store,
        prepare,
        confirm,
        cancel,
        now: () => 1_000,
      });
      const request = {
        effect: {
          kind: "operation",
          command: {
            kind: "start-terminal",
            threadId: "20000000-0000-4000-8000-000000000001",
            checkoutId: "30000000-0000-4000-8000-000000000001",
            operationId: "40000000-0000-4000-8000-000000000001",
            terminalId: "60000000-0000-4000-8000-000000000001",
            columns: 100,
            rows: 30,
            credentialRefs: [],
          },
        },
      };
      const confirmation = { challengeId: "70000000-0000-4000-8000-000000000001" };
      await handle(
        nativeRequest("/api/desktop/code-operation-approval-challenges", request, mainHeaders(f.a)),
      );
      await handle(
        nativeRequest(
          "/api/desktop/code-operation-approval-confirmations",
          confirmation,
          mainHeaders(f.a),
        ),
      );
      expect(
        (
          await handle(
            nativeRequest(
              "/api/desktop/code-operation-approval-cancellations",
              confirmation,
              mainHeaders(f.a),
            ),
          )
        )?.status,
      ).toBe(204);
      expect(prepare).toHaveBeenCalledWith(windowA, request);
      expect(confirm).toHaveBeenCalledWith(windowA, confirmation);
      expect(cancel).toHaveBeenCalledWith(windowA, confirmation);
      expect(
        (
          await handle(
            nativeRequest("/api/desktop/code-operation-approval-cancellations", confirmation, {
              ...mainHeaders(f.a),
              "x-octant-window-capability": f.b.capability,
            }),
          )
        )?.status,
      ).toBe(401);
      expect(cancel).toHaveBeenCalledTimes(1);
    });

    it("reads, sets and clears a provider key", async () => {
      const f = fixture();
      const handle = createProviderCredentialRouteHandler({
        desktopBridgeSecret: secret,
        windowAuthorityStore: f.store,
        readProviderInstances: () => [],
        readRemovedProviderInstanceIds: () => [],
        credentials: undefined,
        journal: {} as never,
        reprobe: vi.fn(),
        removeProvider: vi.fn(),
        now: () => 1_000,
      });
      for (const [route, body] of [
        ["status", { instance: "openai" }],
        ["set", { instance: "openai", credential: "key", replace: false }],
        ["remove", { instance: "openai" }],
      ] as const) {
        // Past admission, this host has no credential store to answer with.
        expect(
          (
            await handle(
              nativeRequest(`/api/desktop/provider-credentials/${route}`, body, mainHeaders(f.a)),
            )
          )?.status,
        ).toBe(503);
        expect(
          (
            await handle(
              nativeRequest(`/api/desktop/provider-credentials/${route}`, body, {
                "x-octant-window-capability": f.a.capability,
              }),
            )
          )?.status,
        ).toBe(401);
      }
    });
  });
});
