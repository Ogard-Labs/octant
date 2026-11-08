import { describe, expect, it } from "vitest";
import { resolveSettingsCliCommand, runSettingsCliCommand } from "./settingsCommand";
import type { LocalControlRequest, OpenedLocalControlSession } from "./localControl";

const now = "2026-10-09T09:00:00.000Z";

function host(options: { refuse?: boolean } = {}) {
  const seen: LocalControlRequest[] = [];
  const session: OpenedLocalControlSession = {
    kind: "opened",
    windowId: "11111111-1111-4111-8111-111111111111",
    send: async (request) => {
      seen.push(request);
      if (request.path === "/api/code/bootstrap") {
        return {
          status: 200,
          body: {
            settings: {
              defaultExecutionPolicy: "approval-gated",
              defaultPermissionPersistence: "current-session",
              version: 3,
              updatedAt: now,
            },
            threads: [],
            checkouts: [],
          },
        };
      }
      if (request.path === "/api/work/threads/bootstrap") {
        return {
          status: 200,
          body: {
            threads: [],
            settings: {
              defaultAccess: "ask-first",
              defaultProviderInstanceId: "50000000-0000-4000-8000-000000000001",
              defaultModelId: "loopback-model",
              version: 2,
              updatedAt: now,
            },
          },
        };
      }
      if (options.refuse === true) return { status: 403, body: { message: "refused" } };
      return { status: 200, body: { kind: "settings-updated" } };
    },
    close: async () => undefined,
  };
  const out: string[] = [];
  const err: string[] = [];
  const stdout = {
    write: (text: string) => (out.push(text), true),
  } as unknown as NodeJS.WritableStream;
  const stderr = {
    write: (text: string) => (err.push(text), true),
  } as unknown as NodeJS.WritableStream;
  return { session, seen, out, err, stdout, stderr };
}

describe("settings access", () => {
  it("parses the mode and the --work flag, and refuses unknown modes and Plan for Work", () => {
    expect(resolveSettingsCliCommand(["access", "full-access"], {})).toEqual({
      action: "access",
      mode: "full-access",
      work: false,
    });
    expect(resolveSettingsCliCommand(["access", "auto"], { work: true })).toMatchObject({
      mode: "auto",
      work: true,
    });
    expect(resolveSettingsCliCommand(["access", "plan"], { work: true })).toBeUndefined();
    expect(resolveSettingsCliCommand(["access", "yolo"], {})).toBeUndefined();
    expect(resolveSettingsCliCommand(["access"], {})).toBeUndefined();
    expect(resolveSettingsCliCommand(["other", "auto"], {})).toBeUndefined();
    expect(resolveSettingsCliCommand(["access", "auto"], { bogus: true })).toBeUndefined();
  });

  it("sets the global Code default through update-code-settings, keeping the stored persistence", async () => {
    const fake = host();
    const code = await runSettingsCliCommand({
      command: { action: "access", mode: "full-access", work: false },
      session: fake.session,
      stdout: fake.stdout,
      stderr: fake.stderr,
    });
    expect(code).toBe(0);
    const update = fake.seen.find((request) => request.path === "/api/code/commands");
    expect(update?.body).toEqual({
      kind: "update-code-settings",
      expectedVersion: 3,
      defaultExecutionPolicy: "full-access",
      defaultPermissionPersistence: "current-session",
      defaultAutoApprove: false,
    });
    expect(fake.out.join("")).toContain("Full access");
  });

  it("maps auto to the approval-gated posture with the reviewer flag", async () => {
    const fake = host();
    const code = await runSettingsCliCommand({
      command: { action: "access", mode: "auto", work: false },
      session: fake.session,
      stdout: fake.stdout,
      stderr: fake.stderr,
    });
    expect(code).toBe(0);
    const update = fake.seen.find((request) => request.path === "/api/code/commands");
    expect(update?.body).toMatchObject({
      defaultExecutionPolicy: "approval-gated",
      defaultAutoApprove: true,
    });
  });

  it("sets the global Work default through update-work-settings", async () => {
    const fake = host();
    const code = await runSettingsCliCommand({
      command: { action: "access", mode: "full-access", work: true },
      session: fake.session,
      stdout: fake.stdout,
      stderr: fake.stderr,
    });
    expect(code).toBe(0);
    const update = fake.seen.find((request) => request.path === "/api/work/threads/commands");
    // The stored default model goes back unchanged, so the access change
    // does not clear it.
    expect(update?.body).toEqual({
      kind: "update-work-settings",
      expectedVersion: 2,
      defaultProviderInstanceId: "50000000-0000-4000-8000-000000000001",
      defaultModelId: "loopback-model",
      defaultAccess: "full-access",
    });
  });

  it("reports a refused change and exits nonzero", async () => {
    const fake = host({ refuse: true });
    const code = await runSettingsCliCommand({
      command: { action: "access", mode: "full-access", work: false },
      session: fake.session,
      stdout: fake.stdout,
      stderr: fake.stderr,
    });
    expect(code).toBe(1);
    expect(fake.err.join("")).toContain("refused");
  });
});
