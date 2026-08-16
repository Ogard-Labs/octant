import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => "/tmp"),
    on: vi.fn(),
    quit: vi.fn(),
    requestSingleInstanceLock: vi.fn(() => true),
    setAsDefaultProtocolClient: vi.fn(() => true),
    setName: vi.fn(),
    setPath: vi.fn(),
    whenReady: vi.fn(() => new Promise<void>(() => undefined)),
  },
  BrowserWindow: class {
    static fromWebContents() {
      return null;
    }
  },
  dialog: { showErrorBox: vi.fn(), showOpenDialog: vi.fn() },
  ipcMain: { handle: vi.fn() },
  nativeTheme: {
    prefersReducedTransparency: false,
    shouldUseHighContrastColors: false,
  },
  powerMonitor: {},
  screen: {},
  systemPreferences: {},
}));

import {
  HOST_IDENTITY_KEY_ID,
  HostIdentitySigningFailure,
  makeHostIdentitySigningService,
  type KeychainHelperExecutor,
} from "./hostIdentityKeychain";
import { installHostIdentityIpcHandlers } from "./main";

/**
 * Native authority JS broker/IPC evidence that a Linux cloud runner CAN
 * execute. These are INJECTABLE-SEAM / UNIT rows,
 * NOT a packaged-native authority pass: `electron` is mocked, window ownership is
 * a string comparison, the Keychain helper executor is injected, and the app
 * bundle / native `octant-keychain-helper` are never loaded. They drive the
 * real host-identity signing broker (`makeHostIdentitySigningService`) through
 * the real owned-window IPC authority installer (`installHostIdentityIpcHandlers`)
 * to prove the JS↔helper contract and fail-closed states.
 *
 * A broken packaged IPC/Keychain boundary would still pass these rows, so
 * packaged native-only authority remains Not run — the S1–S4 named skips in
 * the remote native exit-evidence checklist cover the real Apple-Silicon
 * `security(1)` Keychain + Secure Enclave path.
 */

const helperPath = "/Applications/Octant.app/Contents/Resources/native/octant-keychain-helper";
const fingerprint = "a".repeat(64);
const storeScope = "7d444840-9dc0-41d1-b245-5ffdce74fad2";

const STATUS = "octant:remote-host-identity:status";
const ROTATE = "octant:remote-host-identity:rotate";
const RECOVER = "octant:remote-host-identity:recover";

function okResponse(body: Record<string, unknown>, exitCode = 0) {
  return { exitCode, stdout: `${JSON.stringify(body)}\n`, stderr: "" };
}

function installOn(execute: KeychainHelperExecutor) {
  const service = makeHostIdentitySigningService(helperPath, { execute, storeScope });
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  installHostIdentityIpcHandlers({
    handle: (channel, handler) => handlers.set(channel, handler),
    resolveOwnedWindow: (event) => {
      if (event !== "owned") throw new Error("foreign window");
    },
    service,
  });
  return { service, handlers };
}

describe("native authority JS broker/IPC (injectable Keychain seam, not packaged-native)", () => {
  it("N1 reports a ready recovery state and signs when the native key store is available", async () => {
    const execute = vi.fn<KeychainHelperExecutor>(async (spec) => {
      const request = JSON.parse(spec.stdin.trim()) as { operation: string };
      if (request.operation === "sign") {
        return okResponse({
          version: 1,
          ok: true,
          operation: "sign",
          keyId: HOST_IDENTITY_KEY_ID,
          fingerprint,
          signature: "c2ln",
        });
      }
      return okResponse({
        version: 1,
        ok: true,
        operation: request.operation,
        keyId: HOST_IDENTITY_KEY_ID,
        fingerprint,
      });
    });
    const { service, handlers } = installOn(execute);

    await expect(handlers.get(STATUS)?.("owned")).resolves.toEqual({
      status: "ready",
      reason: null,
      remoteIdentityUsable: true,
      localDesktopUsable: true,
      fingerprint,
    });
    await expect(service.sign(new TextEncoder().encode("challenge"))).resolves.toMatchObject({
      fingerprint,
      signature: "c2ln",
    });
  });

  it("N2 fails closed to recovery-required when the Keychain is unavailable while local desktop stays usable", async () => {
    const execute = vi.fn<KeychainHelperExecutor>(async () =>
      okResponse({ version: 1, ok: false, error: "unavailable" }, 1),
    );
    const { service, handlers } = installOn(execute);

    await expect(handlers.get(STATUS)?.("owned")).resolves.toEqual({
      status: "recovery-required",
      reason: "unavailable",
      remoteIdentityUsable: false,
      localDesktopUsable: true,
    });
    await expect(handlers.get(RECOVER)?.("owned")).rejects.toThrow(
      /secure host-identity store is unavailable/i,
    );
    await expect(service.ensureIdentityKey()).rejects.toMatchObject({
      name: "HostIdentitySigningFailure",
      category: "unavailable",
    });
    await expect(service.sign(new Uint8Array([1, 2, 3]))).rejects.toMatchObject({
      category: "unavailable",
    });
  });

  it("N3 fails closed for cloned data without a native key (helper reports the key missing)", async () => {
    const execute = vi.fn<KeychainHelperExecutor>(async () =>
      okResponse({ version: 1, ok: false, error: "missing" }, 1),
    );
    const { service, handlers } = installOn(execute);

    await expect(handlers.get(STATUS)?.("owned")).resolves.toEqual({
      status: "recovery-required",
      reason: "missing",
      remoteIdentityUsable: false,
      localDesktopUsable: true,
    });
    await expect(service.sign(new Uint8Array([9]))).rejects.toMatchObject({
      name: "HostIdentitySigningFailure",
      category: "missing",
    });
  });

  it("N4 keeps native host-identity operations behind owned-window authority and never leaks helper diagnostics", async () => {
    const execute = vi.fn<KeychainHelperExecutor>(async () => {
      throw new Error("spawn EACCES /secret/native/path private-value");
    });
    const { handlers } = installOn(execute);

    await expect(handlers.get(STATUS)?.("foreign")).rejects.toThrow(
      /unauthorized host-identity request/i,
    );
    await expect(handlers.get(ROTATE)?.("foreign")).rejects.toThrow(
      /unauthorized host-identity request/i,
    );

    const statusFailure = await Promise.resolve(handlers.get(STATUS)?.("owned")).catch(
      (error: unknown) => error,
    );
    // A helper crash is mapped to typed unavailable recovery state, not a thrown leak.
    expect(statusFailure).toMatchObject({ status: "recovery-required", reason: "unavailable" });

    const rotateFailure = await Promise.resolve(handlers.get(ROTATE)?.("owned")).catch(
      (error: unknown) => error,
    );
    expect(String((rotateFailure as Error).message)).not.toMatch(/EACCES|secret|private-value/i);
    expect(rotateFailure).not.toBeInstanceOf(HostIdentitySigningFailure);
  });
});
