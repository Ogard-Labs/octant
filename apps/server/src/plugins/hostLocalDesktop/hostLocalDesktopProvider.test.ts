import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decodeDesktopHostTag,
  decodeDesktopLeaseId,
  decodeDesktopRecipe,
  decodeUtcTimestamp,
  type DesktopLeaseId,
  type DesktopRecipe,
} from "@octant/contracts";
import type {
  DesktopLaunchPort,
  DesktopProvider,
  DesktopScreen,
} from "@octant/plugin-api/desktop-provider";
import { runDesktopProviderConformance } from "@octant/plugin-api/desktop-provider-conformance";
import {
  createHostLocalDesktopProvider,
  HOST_LOCAL_DESKTOP_PROGRAMS,
  hostLocalKeysym,
} from "./hostLocalDesktopProvider";

const recipe: DesktopRecipe = decodeDesktopRecipe({
  providerId: "host-local",
  screen: { width: 640, height: 480 },
  network: "none",
  leaseMinutes: 30,
  maximumLeaseMinutes: 240,
  idleMinutes: 15,
});
const hostTag = decodeDesktopHostTag("e2000000-0000-4000-8000-0000000000aa");
const encoder = new TextEncoder();

/** A PNG header for a `width` by `height` image; the driver reads no further. */
function pngOf(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13], 0);
  bytes.set(encoder.encode("IHDR"), 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

interface FakeDesktop {
  readonly hostTag: string;
  readonly lines: Array<string>;
  readonly output: (chunk: Uint8Array) => void;
  exit: () => void;
}

/**
 * An in-memory launch port whose desktop speaks the driver's protocol. A
 * test can make the desktop say something else, stay running after a stop,
 * or never become ready.
 */
function fakeLaunchPort(
  options: {
    readonly frame?: Uint8Array;
    readonly reply?: (line: string) => Uint8Array | undefined;
    readonly lingerAfterStop?: boolean;
    readonly neverReady?: boolean;
  } = {},
) {
  const desktops = new Map<string, FakeDesktop>();
  const stopped: Array<string> = [];
  const port: DesktopLaunchPort = {
    readiness: (programs) =>
      programs.includes("Xvfb") ? { status: "ready" } : { status: "refused", reason: "missing" },
    launch: async (request) => {
      if (request.signal.aborted) return { status: "cancelled" };
      let exit: () => void = () => undefined;
      const exited = new Promise<void>((resolve) => {
        exit = resolve;
      });
      const desktop: FakeDesktop = {
        hostTag: String(request.hostTag),
        lines: [],
        output: request.output,
        exit,
      };
      desktops.set(String(request.leaseId), desktop);
      const [, width, height] = request.args.slice(2);
      if (options.neverReady !== true) {
        queueMicrotask(() => request.output(encoder.encode(`ready ${width} ${height}\n`)));
      }
      return {
        status: "launched",
        desktop: {
          exited,
          write: async (bytes) => {
            const line = new TextDecoder().decode(bytes).trimEnd();
            desktop.lines.push(line);
            const custom = options.reply?.(line);
            if (custom !== undefined) {
              queueMicrotask(() => request.output(custom));
            } else if (line === "frame") {
              const frame = options.frame ?? pngOf(640, 480);
              queueMicrotask(() => {
                request.output(encoder.encode(`frame ${frame.length}\n`));
                request.output(frame);
              });
            } else {
              queueMicrotask(() => request.output(encoder.encode("ok\n")));
            }
            return { status: "written" };
          },
        },
      };
    },
    stop: async (leaseId) => {
      stopped.push(String(leaseId));
      if (options.lingerAfterStop !== true) {
        desktops.get(String(leaseId))?.exit();
        desktops.delete(String(leaseId));
      }
      return { status: "released" };
    },
    inspect: async (leaseId) =>
      desktops.has(String(leaseId)) ? { status: "present" } : { status: "gone" },
    listOwned: async (tag) => ({
      status: "listed",
      leaseIds: [...desktops.entries()]
        .filter(([, desktop]) => desktop.hostTag === String(tag))
        .map(([key]) => decodeDesktopLeaseId(key)),
    }),
  };
  return { port, desktops, stopped };
}

const freshLease = (): DesktopLeaseId => decodeDesktopLeaseId(randomUUID());
const later = decodeUtcTimestamp("2026-10-26T13:00:00.000Z");

async function acquired(provider: DesktopProvider, leaseId = freshLease()) {
  const result = await provider.acquire({
    leaseId,
    hostTag,
    recipe,
    expiresAt: later,
    signal: new AbortController().signal,
  });
  if (result.status !== "acquired") throw new Error(`not acquired: ${JSON.stringify(result)}`);
  return result.handle;
}

async function screenOf(provider: DesktopProvider): Promise<DesktopScreen> {
  const handle = await acquired(provider);
  const screen = await provider.screen(handle);
  if (screen.status !== "ready") throw new Error("no screen");
  return screen.screen;
}

describe("host-local desktop provider", () => {
  it("keeps the desktop-provider seam's promises over its launch port", async () => {
    await expect(
      runDesktopProviderConformance({
        create: (scenario) => {
          const { port, desktops } = fakeLaunchPort({
            lingerAfterStop: scenario.desktopOutlivesDestroy,
          });
          const provider = createHostLocalDesktopProvider(port);
          if (!scenario.providerDeclinesExtension) return provider;
          // A host-local desktop has no clock to move; the only extension it
          // cannot take is one for a desktop that is no longer running.
          return {
            ...provider,
            extend: async (handle, expiresAt) => {
              desktops.get(String(handle.leaseId))?.exit();
              await new Promise((resolve) => setTimeout(resolve, 0));
              return provider.extend(handle, expiresAt);
            },
          };
        },
        recipe,
        unsupportedCommand: { operation: "apps" },
      }),
    ).resolves.toMatchObject({ stoppedWhenCancelled: true, reportedAbsenceOnlyWhenAbsent: true });
  });

  it("keeps to the imports a third-party desktop plugin could make", () => {
    const files = readdirSync(import.meta.dirname).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(join(import.meta.dirname, file), "utf8");
      const specifiers = [
        ...source.matchAll(
          /\bfrom\s+"([^"]+)"|\bimport\s*\(\s*"([^"]+)"|^\s*import\s+"([^"]+)"|\brequire\(\s*"([^"]+)"/gm,
        ),
      ].map((match) => match[1] ?? match[2] ?? match[3] ?? match[4] ?? "");
      for (const specifier of specifiers) {
        expect(
          specifier.startsWith("./") ||
            [
              "@octant/contracts",
              "@octant/contracts/computer-use-plugin",
              "@octant/plugin-api/desktop-provider",
            ].includes(specifier),
          `${file} imports ${specifier}`,
        ).toBe(true);
      }
    }
  });

  it("reports readiness only when every program it runs is present", async () => {
    const { port } = fakeLaunchPort();
    const asked: Array<ReadonlyArray<string>> = [];
    const provider = createHostLocalDesktopProvider({
      ...port,
      readiness: (programs) => {
        asked.push(programs);
        return port.readiness(programs);
      },
    });
    await expect(provider.status()).resolves.toEqual({ status: "ready" });
    expect(asked).toEqual([HOST_LOCAL_DESKTOP_PROGRAMS]);
  });

  it("refuses a recipe that allows the network without launching anything", async () => {
    const { port, desktops } = fakeLaunchPort();
    const provider = createHostLocalDesktopProvider(port);
    await expect(
      provider.acquire({
        leaseId: freshLease(),
        hostTag,
        recipe: { ...recipe, network: "allow" },
        expiresAt: later,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ status: "refused", reason: "network-allow-unsupported" });
    expect(desktops.size).toBe(0);
  });

  it("stops a desktop still starting when its acquisition is cancelled", async () => {
    const { port, stopped } = fakeLaunchPort({ neverReady: true });
    const provider = createHostLocalDesktopProvider(port);
    const controller = new AbortController();
    const leaseId = freshLease();
    const pending = provider.acquire({
      leaseId,
      hostTag,
      recipe,
      expiresAt: later,
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await expect(pending).resolves.toEqual({ status: "cancelled" });
    expect(stopped).toEqual([String(leaseId)]);
  });

  it("sends only integers, known keysyms, and base64 text to the desktop", async () => {
    const { port, desktops } = fakeLaunchPort();
    const screen = await screenOf(createHostLocalDesktopProvider(port));
    const [desktop] = [...desktops.values()];

    await expect(
      screen.input({ kind: "pointer", action: "move", x: 10.7, y: 20.2 }),
    ).resolves.toEqual({
      status: "delivered",
    });
    await screen.input({ kind: "pointer", action: "down", button: "right", x: 1, y: 2 });
    await screen.input({ kind: "key", action: "down", key: "Enter" });
    await screen.input({ kind: "text", text: "a; rm -rf ~\n$(id)" });
    await screen.input({ kind: "scroll", x: 5, y: 5, deltaX: 0, deltaY: -10_000 });

    expect(desktop?.lines).toEqual([
      "move 10 20",
      "down 1 2 3",
      "keydown Return",
      `text ${btoa("a; rm -rf ~\n$(id)")}`,
      "scroll 5 5 4 10",
    ]);
    await expect(screen.input({ kind: "pointer", action: "move", x: 640, y: 0 })).resolves.toEqual({
      status: "refused",
      reason: "outside-screen",
    });
    for (const key of ["$(reboot)", "constructor", "__proto__", "toString"]) {
      await expect(screen.input({ kind: "key", action: "down", key })).resolves.toEqual({
        status: "refused",
        reason: "unsupported-key",
      });
    }
    for (const [x, y] of [
      [-1, 0],
      [0, Number.NaN],
      [Number.POSITIVE_INFINITY, 0],
    ] as const) {
      await expect(screen.input({ kind: "pointer", action: "move", x, y })).resolves.toEqual({
        status: "refused",
        reason: "outside-screen",
      });
    }
    await expect(
      screen.input({ kind: "scroll", x: 1, y: 1, deltaX: 0, deltaY: Number.NaN }),
    ).resolves.toEqual({ status: "refused", reason: "invalid-scroll" });
    expect(desktop?.lines).toHaveLength(5);
    expect(hostLocalKeysym("F12")).toBe("F12");
    expect(hostLocalKeysym("F13")).toBeUndefined();
  });

  it("returns a frame within the screen and refuses a larger one before decoding it", async () => {
    const fitting = await screenOf(createHostLocalDesktopProvider(fakeLaunchPort().port));
    await expect(fitting.frame()).resolves.toMatchObject({
      status: "frame",
      frame: { mediaType: "image/png", width: 640, height: 480 },
    });

    const oversized = await screenOf(
      createHostLocalDesktopProvider(fakeLaunchPort({ frame: pngOf(4_000, 480) }).port),
    );
    await expect(oversized.frame()).resolves.toEqual({
      status: "failed",
      reason: "frame-out-of-bounds",
    });
  });

  it("stops trusting a desktop that writes anything outside the protocol", async () => {
    const { port } = fakeLaunchPort({
      reply: (line) =>
        line === "frame" ? encoder.encode(`frame ${10 * 1024 * 1024 * 1024}\n`) : undefined,
    });
    const screen = await screenOf(createHostLocalDesktopProvider(port));
    await expect(screen.frame()).resolves.toEqual({ status: "not-connected" });
    await expect(screen.input({ kind: "pointer", action: "move", x: 1, y: 1 })).resolves.toEqual({
      status: "not-connected",
    });
  });

  it("stops trusting a desktop that answers a request twice", async () => {
    const { port } = fakeLaunchPort({
      reply: (line) => (line.startsWith("move") ? encoder.encode("ok\nok\n") : undefined),
    });
    const screen = await screenOf(createHostLocalDesktopProvider(port));
    await expect(screen.input({ kind: "pointer", action: "move", x: 1, y: 1 })).resolves.toEqual({
      status: "delivered",
    });
    // The extra reply would otherwise answer the next request in its place.
    await expect(screen.frame()).resolves.toEqual({ status: "not-connected" });
  });

  it("refuses every agent command and every delivery until those slices bind them", async () => {
    const provider = createHostLocalDesktopProvider(fakeLaunchPort().port);
    const handle = await acquired(provider);
    await expect(
      provider.control(handle, { operation: "launch", appId: "org.example.app" }),
    ).resolves.toMatchObject({
      kind: "refused",
      reason: "unsupported",
    });
    await expect(provider.deliver(handle, "app", new Uint8Array(1))).resolves.toEqual({
      status: "refused",
      reason: "unsupported",
    });
  });
});
