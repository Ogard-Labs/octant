import { describe, expect, it, vi } from "vitest";
import { createWindowsListenerTlsFiles, type WindowsListenerTlsNative } from "./windowsListenerTls";
import type { WindowsHostProfilePaths } from "./windowsHostProfile";

const paths: WindowsHostProfilePaths = {
  platform: "win32",
  profile: "octant",
  profileId: "11111111-1111-4111-8111-111111111111",
  rootDirectory: "C:\\owned\\Octant\\hosts\\octant",
  dataDirectory: "C:\\owned\\Octant\\hosts\\octant\\data",
  configDirectory: "C:\\owned\\Octant\\hosts\\octant\\config",
  stateDirectory: "C:\\owned\\Octant\\hosts\\octant\\state",
  logsDirectory: "C:\\owned\\Octant\\hosts\\octant\\logs",
};
function native(operation: (...args: ReadonlyArray<unknown>) => unknown): WindowsListenerTlsNative {
  return {
    apiVersion: 1,
    frameBytes: 16384,
    openProfile: vi.fn(),
    prepare: vi.fn(),
    claim: vi.fn(),
    poll: vi.fn(),
    reply: vi.fn(),
    close: vi.fn(),
    lookup: vi.fn(),
    beginRequest: vi.fn(),
    pollRequest: vi.fn(),
    closeRequest: vi.fn(),
    listenerTlsFile: operation,
  };
}
describe("Windows listener TLS storage", () => {
  it("binds fixed TLS purposes to native profile authority and erases the returned transfer buffer", () => {
    const raw = Buffer.from("private fixture");
    const operation = vi.fn(() => ({
      status: "ready",
      dataDirectory: paths.dataDirectory,
      bytes: raw,
    }));
    const result = createWindowsListenerTlsFiles(native(operation), paths)?.read("key");
    expect(operation).toHaveBeenCalledWith(
      paths.profile,
      paths.profileId,
      paths.dataDirectory,
      "key",
      null,
    );
    expect(result?.status).toBe("ready");
    if (result?.status === "ready")
      expect(result.bytes.equals(Buffer.from("private fixture"))).toBe(true);
    expect(raw.every((byte) => byte === 0)).toBe(true);
  });
  it("refuses incompatible storage, a different native root and oversized writes", () => {
    const { listenerTlsFile: ignored, ...old } = native(vi.fn());
    void ignored;
    expect(createWindowsListenerTlsFiles(old, paths)).toBeUndefined();
    const raw = Buffer.from("private fixture");
    const wrongRoot = createWindowsListenerTlsFiles(
      native(() => ({ status: "ready", dataDirectory: "C:\\other", bytes: raw })),
      paths,
    );
    expect(wrongRoot?.read("key")).toEqual({ status: "refused" });
    expect(raw.every((byte) => byte === 0)).toBe(true);
    const operation = vi.fn();
    const files = createWindowsListenerTlsFiles(native(operation), paths);
    expect(files?.createKey(Buffer.alloc(4097))).toEqual({ status: "refused" });
    expect(files?.createCertificate(Buffer.alloc(16385))).toEqual({ status: "refused" });
    expect(files?.replaceCertificate(Buffer.alloc(16385))).toEqual({ status: "refused" });
    expect(operation).not.toHaveBeenCalled();
  });
  it("asks native storage to replace a certificate only for renewal", () => {
    const operation = vi.fn((): unknown => ({ status: "refused" }));
    const files = createWindowsListenerTlsFiles(native(operation), paths);
    const candidate = Buffer.from("public fixture");
    files?.createCertificate(candidate);
    files?.replaceCertificate(candidate);
    expect(operation.mock.calls.map((call: ReadonlyArray<unknown>) => call[3])).toEqual([
      "certificate",
      "certificate-renewal",
    ]);
  });
  it("retains exposed-key refusals and distinguishes an empty renewable certificate from an empty key", () => {
    const operation = vi.fn((): unknown => ({ status: "exposed" }));
    const files = createWindowsListenerTlsFiles(native(operation), paths);
    expect(files?.read("key")).toEqual({ status: "exposed" });
    operation.mockReturnValue({
      status: "ready",
      dataDirectory: paths.dataDirectory,
      bytes: Buffer.alloc(0),
    });
    expect(files?.read("key")).toEqual({ status: "refused" });
    const certificate = files?.read("certificate");
    expect(certificate?.status).toBe("ready");
    if (certificate?.status === "ready") expect(certificate.bytes.length).toBe(0);
  });
});
