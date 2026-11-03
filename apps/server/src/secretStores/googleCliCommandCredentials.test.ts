import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGoogleCliCommandCredentials } from "./googleCliCommandCredentials";
import type { GoogleCliSessionAnswer } from "./secretStoreBrokerClient";
import { redactHostSecrets } from "../process/secretRedaction";
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
const now = Date.parse("2026-11-02T23:00:00.000Z");
const issued: GoogleCliSessionAnswer = {
  status: "issued",
  accessToken: "fixture-command-short-token",
  expiration: new Date(now + 3600000).toISOString(),
  serviceAccountEmail: "commands@example.iam.gserviceaccount.com",
  scopes: ["https://www.googleapis.com/auth/cloud-platform.read-only"],
};
async function paths() {
  const directory = await mkdtemp(join(tmpdir(), "octant-google-resources-"));
  directories.push(directory);
  const scriptRoot = join(directory, "scripts");
  await mkdir(scriptRoot, { mode: 0o700 });
  const commandDirectory = await mkdtemp(join(scriptRoot, "octant-harness-"));
  return {
    directory,
    scriptRoot,
    commandDirectory,
    configurationRoot: join(directory, "cloud-cli"),
  };
}
describe("Google token files belong to one command", () => {
  it("leaves prior credential resources untouched until owned process recovery is confirmed", async () => {
    const p = await paths();
    const stale = join(p.configurationRoot, "google-prior");
    await mkdir(stale, { recursive: true });
    await writeFile(join(stale, "access-token"), "fixture-prior-token");
    const session = vi.fn(async () => issued);
    const resources = createGoogleCliCommandCredentials({
      ...p,
      broker: {
        googleCliSession: session,
        googleCliReference: async () => ({
          status: "linked" as const,
          pointer: {
            store: "onepassword" as const,
            reference: "op://Private/Google/key",
            serviceAccountEmail: issued.serviceAccountEmail,
            scopes: issued.scopes,
          },
        }),
      },
      now: () => now,
    });
    expect(await readFile(join(stale, "access-token"), "utf8")).toBe("fixture-prior-token");
    expect(
      await resources.recover(async () => {
        throw new Error("Owned process identity unavailable");
      }),
    ).toMatchObject({ status: "unavailable", phase: "process-recovery" });
    const entry = await resources.prepare(p.commandDirectory);
    if (entry?.status !== "ready")
      throw new Error("Unrelated command should retain a token-free path");
    expect(entry.configurationDirectory).toBeUndefined();
    expect(entry.warning).toMatch(/recovery/);
    const token = entry.environment.CLOUDSDK_AUTH_ACCESS_TOKEN_FILE;
    if (token === undefined) throw new Error("Empty token file missing");
    expect(await readFile(token, "utf8")).toBe("");
    expect(session).not.toHaveBeenCalled();
    await entry.close();
    expect(await readFile(join(stale, "access-token"), "utf8")).toBe("fixture-prior-token");
  });
  it("bounds held process recovery, leaves files untouched after a late answer, and does not mint for an unconfigured channel", async () => {
    const p = await paths();
    const stale = join(p.configurationRoot, "google-prior");
    await mkdir(stale, { recursive: true });
    await writeFile(join(stale, "access-token"), "fixture-prior-token");
    const held = Promise.withResolvers<void>();
    const session = vi.fn(async () => issued);
    const resources = createGoogleCliCommandCredentials({
      ...p,
      recoveryWaitMs: 30,
      broker: { googleCliSession: session, googleCliReference: async () => ({ status: "none" }) },
      now: () => now,
    });
    expect(await resources.recover(() => held.promise)).toMatchObject({
      status: "unavailable",
      phase: "process-recovery",
    });
    held.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(await readFile(join(stale, "access-token"), "utf8")).toBe("fixture-prior-token");
    expect(await resources.prepare(p.commandDirectory)).toBeUndefined();
    expect(session).not.toHaveBeenCalled();
  });
  it("refuses a linked resource root without deleting or reading its target's tokens", async () => {
    const p = await paths();
    const outside = join(p.directory, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "access-token"), "keep-outside");
    await symlink(outside, p.configurationRoot);
    const session = vi.fn(async () => issued);
    const resources = createGoogleCliCommandCredentials({
      ...p,
      broker: { googleCliSession: session },
      now: () => now,
    });
    expect(await resources.recover(async () => {})).toMatchObject({
      status: "unavailable",
      phase: "resource-cleanup",
    });
    const entry = await resources.prepare(p.commandDirectory);
    if (entry?.status !== "ready") throw new Error("Token-free command path unavailable");
    expect(entry.configurationDirectory).toBeUndefined();
    expect(session).not.toHaveBeenCalled();
    await entry.close();
    expect(await readFile(join(outside, "access-token"), "utf8")).toBe("keep-outside");
  });
  it("uses private token-only bytes, isolated config and issued-secret redaction, preserving an already-started command until close", async () => {
    const p = await paths();
    const resources = createGoogleCliCommandCredentials({
      ...p,
      broker: { googleCliSession: async () => issued },
      now: () => now,
    });
    await resources.recover(async () => {});
    const entry = await resources.prepare(p.commandDirectory);
    expect(entry?.status).toBe("ready");
    if (entry?.status !== "ready") throw new Error("Prepared command unavailable");
    const tokenFile = entry.environment.CLOUDSDK_AUTH_ACCESS_TOKEN_FILE;
    if (tokenFile === undefined) throw new Error("Token path missing");
    expect(await readFile(tokenFile, "utf8")).toBe(issued.accessToken);
    expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);
    expect((await stat(entry.configurationDirectory)).mode & 0o777).toBe(0o700);
    expect(JSON.stringify(entry.environment)).not.toContain(issued.accessToken);
    expect(redactHostSecrets(`printed ${issued.accessToken}`)).not.toContain(issued.accessToken);
    expect(entry.beforeLaunch()).toBe(true);
    expect(entry.beforeLaunch()).toBe(false);
    const finish = resources.beginChange();
    expect(await readFile(tokenFile, "utf8")).toBe(issued.accessToken);
    finish();
    await entry.close();
    await expect(stat(tokenFile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(entry.configurationDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("retires prepared files and refuses their final launch after a selection change", async () => {
    const p = await paths();
    const resources = createGoogleCliCommandCredentials({
      ...p,
      broker: { googleCliSession: async () => issued },
      now: () => now,
    });
    await resources.recover(async () => {});
    const entry = await resources.prepare(p.commandDirectory);
    if (entry?.status !== "ready") throw new Error("Prepared command unavailable");
    const finish = resources.beginChange();
    expect(entry.beforeLaunch()).toBe(false);
    await entry.close();
    finish();
    expect(await readdir(p.commandDirectory)).toEqual([]);
    expect(await readdir(p.configurationRoot)).toEqual([]);
  });
  it("drops a late broker result after abort or selection change, and aborts the owned transport wait", async () => {
    const p = await paths();
    const reply = Promise.withResolvers<GoogleCliSessionAnswer>();
    let requestSignal: AbortSignal | undefined;
    const resources = createGoogleCliCommandCredentials({
      ...p,
      broker: {
        googleCliSession: async (signal) => {
          requestSignal = signal;
          return reply.promise;
        },
      },
      now: () => now,
    });
    const controller = new AbortController();
    await resources.recover(async () => {});
    const pending = resources.prepare(p.commandDirectory, controller.signal);
    controller.abort();
    expect(await pending).toMatchObject({ status: "refused" });
    expect(requestSignal?.aborted).toBe(true);
    reply.resolve(issued);
    await Promise.resolve();
    expect(await readdir(p.commandDirectory)).toEqual([]);
    expect(await readdir(p.configurationRoot)).toEqual([]);
    const second = Promise.withResolvers<GoogleCliSessionAnswer>();
    const another = createGoogleCliCommandCredentials({
      ...p,
      broker: { googleCliSession: async () => second.promise },
      now: () => now,
    });
    await another.recover(async () => {});
    const preparing = another.prepare(p.commandDirectory);
    const finish = another.beginChange();
    second.resolve(issued);
    expect(await preparing).toMatchObject({ status: "refused" });
    finish();
    expect(await readdir(p.commandDirectory)).toEqual([]);
  });
  it.each(["locked", "expired", "down"])(
    "keeps %s credentials from falling back to the ambient account",
    async (state) => {
      const p = await paths();
      const broker = {
        googleCliSession: async (): Promise<
          GoogleCliSessionAnswer | { status: "broker-unavailable" }
        > =>
          state === "locked"
            ? { status: "locked" }
            : state === "down"
              ? { status: "broker-unavailable" }
              : { ...issued, expiration: new Date(now - 1).toISOString() },
      };
      const resources = createGoogleCliCommandCredentials({ ...p, broker, now: () => now });
      await resources.recover(async () => {});
      const entry = await resources.prepare(p.commandDirectory);
      if (entry?.status !== "ready") throw new Error("Prepared command unavailable");
      const tokenFile = entry.environment.CLOUDSDK_AUTH_ACCESS_TOKEN_FILE;
      if (tokenFile === undefined) throw new Error("Token path missing");
      expect(await readFile(tokenFile, "utf8")).toBe("");
      expect(entry.environment.CLOUDSDK_CONFIG).toBe(entry.configurationDirectory);
      expect(entry.warning).toMatch(/Settings/);
      await entry.close();
    },
  );
  it("bounds a non-answering broker and removes only owned stale resource files on restart", async () => {
    const p = await paths();
    const stale = join(p.configurationRoot, "google-stale");
    await mkdir(stale, { recursive: true });
    await writeFile(join(stale, "token-cache"), "fixture-old-token");
    await writeFile(join(p.commandDirectory, "command.sh"), "old script");
    const outside = join(p.directory, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "google-access-token"), "leave alone");
    await symlink(outside, join(p.scriptRoot, "octant-harness-linked"));
    let signal: AbortSignal | undefined;
    const resources = createGoogleCliCommandCredentials({
      ...p,
      broker: {
        googleCliSession: async (input) => {
          signal = input;
          return new Promise(() => {});
        },
      },
      now: () => now,
      waitMs: 30,
    });
    await resources.recover(async () => {});
    expect(await readFile(join(outside, "google-access-token"), "utf8")).toBe("leave alone");
    expect(await readFile(join(p.commandDirectory, "command.sh"), "utf8")).toBe("old script");
    await expect(stat(stale)).rejects.toMatchObject({ code: "ENOENT" });
    const entry = await resources.prepare(p.commandDirectory);
    expect(signal?.aborted).toBe(true);
    if (entry?.status !== "ready") throw new Error("Prepared command unavailable");
    await entry.close();
    expect(await readdir(p.configurationRoot)).toEqual([]);
  });
});
