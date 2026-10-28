import { describe, expect, it } from "vitest";
import type { LocalControlRequest, LocalControlResponse } from "./localControl";
import {
  resolveAppStoreConnectKeyCliCommand,
  runAppStoreConnectKeyCliCommand,
  type AppStoreConnectKeyCliCommand,
} from "./appStoreConnectKeyCommand";

const PEM = "-----BEGIN PRIVATE KEY-----\nMIG...\n-----END PRIVATE KEY-----\n";

function fixture(
  respond: (request: LocalControlRequest) => LocalControlResponse = () => ({
    status: 200,
    body: { outcome: "stored" },
  }),
) {
  const sent: LocalControlRequest[] = [];
  const out: string[] = [];
  const err: string[] = [];
  return {
    sent,
    out,
    err,
    run: (command: AppStoreConnectKeyCliCommand, stdin = PEM) =>
      runAppStoreConnectKeyCliCommand({
        command,
        session: {
          kind: "opened",
          windowId: "33333333-3333-4333-8333-333333333333",
          send: async (request) => {
            sent.push(request);
            return respond(request);
          },
          close: async () => undefined,
        },
        readStdin: async () => stdin,
        stdout: { write: (chunk: string) => out.push(chunk) },
        stderr: { write: (chunk: string) => err.push(chunk) },
      }),
  };
}

const SET: AppStoreConnectKeyCliCommand = {
  action: "set",
  issuerId: "issuer",
  keyId: "ABCDEFGHIJ",
  replace: false,
};

describe("octant apple key", () => {
  it("takes the private key only from standard input, never from an argument or a flag", () => {
    const ids = { issuer: "issuer", "key-id": "ABCDEFGHIJ" };
    expect(resolveAppStoreConnectKeyCliCommand(["key", "set", PEM], { ...ids, stdin: true })).toBe(
      undefined,
    );
    expect(resolveAppStoreConnectKeyCliCommand(["key", "set"], { ...ids, stdin: PEM })).toBe(
      undefined,
    );
    expect(
      resolveAppStoreConnectKeyCliCommand(["key", "set"], { ...ids, stdin: true, key: PEM }),
    ).toBeUndefined();
    expect(resolveAppStoreConnectKeyCliCommand(["key", "set"], ids)).toBeUndefined();
    expect(
      resolveAppStoreConnectKeyCliCommand(["key", "set"], { ...ids, stdin: true, replace: true }),
    ).toEqual({ ...SET, replace: true });
    expect(resolveAppStoreConnectKeyCliCommand(["key", "status"], {})).toEqual({
      action: "status",
    });
  });

  it("sends the key read from standard input once and prints only the outcome", async () => {
    const { sent, out, err, run } = fixture();
    expect(await run(SET)).toBe(0);
    expect(sent).toEqual([
      {
        path: "/api/desktop/app-store-connect-key/set",
        method: "POST",
        body: { issuerId: "issuer", keyId: "ABCDEFGHIJ", privateKey: PEM.trim(), replace: false },
      },
    ]);
    expect(out.join("")).toBe("This host has an App Store Connect key.\n");
    expect([...out, ...err].join("")).not.toContain("PRIVATE KEY");
  });

  it("sends nothing when standard input is empty", async () => {
    const { sent, err, run } = fixture();
    expect(await run(SET, "\n")).toBe(1);
    expect(sent).toEqual([]);
    expect(err.join("")).toContain("nothing was saved");
  });

  it("names --replace when the host already has a key", async () => {
    const { err, run } = fixture(() => ({
      status: 409,
      body: {
        category: "already-stored",
        message: "This host already has an App Store Connect key.",
      },
    }));
    expect(await run(SET)).toBe(1);
    expect(err.join("")).toContain("--replace");
  });

  it("passes on the host's refusal while distribution is not admitted", async () => {
    const { err, run } = fixture(() => ({
      status: 409,
      body: {
        category: "distribution-not-enabled",
        message: "Uploading, submitting, and releasing are not available.",
      },
    }));
    expect(await run({ action: "status" })).toBe(1);
    expect(err.join("")).toBe("Uploading, submitting, and releasing are not available.\n");
  });
});
