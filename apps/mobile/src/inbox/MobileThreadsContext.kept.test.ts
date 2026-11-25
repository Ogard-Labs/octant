// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { MobileInboxRow, MobileRemoteTransport } from "@octant/client-runtime";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { MobileThreads } from "./MobileThreadsContext";

const phone = vi.hoisted(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  return {
    secure: new Map<string, string>(),
    files: new Map<string, string>(),
    session: undefined as unknown,
    inbox: { rows: [] as ReadonlyArray<unknown>, reachable: true },
    projects: [{ projectId: "travel", name: "Travel" }] as ReadonlyArray<unknown>,
    // The shared packages are the same through a restart, and slow to load again.
    runtime: undefined as typeof import("@octant/client-runtime") | undefined,
    contracts: undefined as typeof import("@octant/contracts") | undefined,
  };
});

vi.mock("../hosts/expoSecureStorage", () => ({
  createExpoSecureStringStorage: () => ({
    getItem: async (key: string) => phone.secure.get(key) ?? null,
    setItem: async (key: string, value: string) => void phone.secure.set(key, value),
    deleteItem: async (key: string) => void phone.secure.delete(key),
  }),
}));
// The app's files outlive a restart; the modules that read them do not.
vi.mock("../outbox/sealedFile", () => ({
  sealedFile: (name: string) => ({
    read: () => phone.files.get(name) ?? null,
    write: (sealed: string) => void phone.files.set(name, sealed),
    remove: () => void phone.files.delete(name),
  }),
}));
vi.mock("./readCursorFile", () => ({
  loadReadCursors: () => null,
  keepReadCursors: () => undefined,
}));
vi.mock("../session/MobileSessionContext", () => ({
  useMobileSession: () => phone.session,
}));
vi.mock("@octant/contracts", async (importOriginal) => {
  phone.contracts ??= await importOriginal<typeof import("@octant/contracts")>();
  return phone.contracts;
});
vi.mock("@octant/client-runtime", async (importOriginal) => {
  phone.runtime ??= await importOriginal<typeof import("@octant/client-runtime")>();
  const actual = phone.runtime;
  const unreachable = () => Promise.reject(new Error("The computer cannot be reached."));
  return {
    ...actual,
    listAllHostsMobileInbox: async (transports: ReadonlyArray<MobileRemoteTransport>) =>
      phone.inbox.reachable
        ? { rows: phone.inbox.rows, failures: [] }
        : {
            rows: [],
            failures: transports.map(({ hostId }) => ({
              hostId,
              category: "offline",
              message: "The computer cannot be reached.",
            })),
          },
    fetchMobileWorkProjects: async () => (phone.inbox.reachable ? phone.projects : unreachable()),
    fetchMobileCodeProjects: async () => (phone.inbox.reachable ? [] : unreachable()),
    fetchMobileProviderCatalog: unreachable,
  };
});

const studio = "11111111-1111-4111-8111-111111111111";
const row: MobileInboxRow = {
  hostId: studio,
  mode: "work",
  threadId: "plan-the-trip",
  title: "Plan the trip",
  status: "idle",
  freshness: "2026-11-25T08:00:00.000Z",
  projectId: "travel",
  live: "working",
};
const transport: MobileRemoteTransport = {
  hostId: studio,
  authenticatedFetch: async () => Response.json({}),
};
function pairedWith(hostKeyFingerprint: string) {
  phone.session = {
    environment: { kind: "live" },
    hosts: [{ hostId: studio, label: "Studio Mac", hostKeyFingerprint, keyId: "device-key" }],
    hostsLoaded: true,
    hostsError: undefined,
    health: [],
    transports: [transport],
  };
}

/** Starts the app afresh: nothing the last run held in memory is left. */
async function launch() {
  vi.resetModules();
  const { MobileThreadsProvider, useMobileThreads } = await import("./MobileThreadsContext");
  let seen: MobileThreads | undefined;
  const Reader = () => {
    seen = useMobileThreads();
    return null;
  };
  const root = createRoot(document.createElement("div"));
  const show = async () => {
    await act(async () =>
      root.render(createElement(MobileThreadsProvider, { children: createElement(Reader) })),
    );
    for (let turn = 0; turn < 5; turn += 1)
      await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  };
  await show();
  return {
    threads: () => {
      if (seen === undefined) throw new Error("The threads were never read.");
      return seen;
    },
    /** The session changed while the app runs. */
    again: show,
    quit: () => act(() => root.unmount()),
  };
}

// The first load reads the shared packages, which is slow on a busy machine;
// every launch after it reloads the app's own modules alone.
beforeAll(async () => {
  await import("./MobileThreadsContext");
}, 60_000);

afterEach(() => {
  phone.secure.clear();
  phone.files.clear();
  phone.projects = [{ projectId: "travel", name: "Travel" }];
});

describe("the thread list after a restart", () => {
  it("is there while the computer cannot be reached, with its Project, and nothing readable on disk", async () => {
    pairedWith("key-1");
    phone.inbox = { rows: [row], reachable: true };
    const first = await launch();
    expect(first.threads().rows.map((entry) => entry.threadId)).toEqual(["plan-the-trip"]);
    first.quit();
    expect([...phone.files.values()].join("")).not.toContain("Plan the trip");

    phone.inbox = { rows: [], reachable: false };
    const later = await launch();
    const [kept] = later.threads().rows;
    expect(kept?.title).toBe("Plan the trip");
    expect(kept?.live).toBeUndefined();
    expect(kept === undefined ? undefined : later.threads().projectName(kept)).toBe("Travel");
    later.quit();
  });

  it("still lets a message wait for a computer that said this phone may write there", async () => {
    pairedWith("key-1");
    phone.inbox = { rows: [row], reachable: true };
    const first = await launch();
    await act(async () => first.threads().noteStanding(studio, { actsAsHostPerson: true }));
    await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));
    first.quit();

    phone.inbox = { rows: [], reachable: false };
    const later = await launch();
    expect(later.threads().lastStanding(studio)).toEqual({ actsAsHostPerson: true });
    later.quit();

    pairedWith("key-2");
    const repaired = await launch();
    expect(repaired.threads().lastStanding(studio)).toBeUndefined();
    repaired.quit();
  });

  it("gives way to what the computer says once it answers", async () => {
    pairedWith("key-1");
    phone.inbox = { rows: [row], reachable: true };
    (await launch()).quit();

    phone.inbox = { rows: [], reachable: true };
    const later = await launch();
    expect(later.threads().rows).toEqual([]);
    later.quit();
  });

  it("is not shown for a computer paired again under another key", async () => {
    pairedWith("key-1");
    phone.inbox = { rows: [row], reachable: true };
    (await launch()).quit();

    pairedWith("key-2");
    phone.inbox = { rows: [], reachable: false };
    const later = await launch();
    expect(later.threads().rows).toEqual([]);
    later.quit();
  });

  it("keeps nothing read under a pairing the computer was paired again from, while the app runs", async () => {
    pairedWith("key-1");
    phone.inbox = { rows: [row], reachable: true };
    const running = await launch();
    phone.inbox = { rows: [], reachable: false };
    pairedWith("key-2");
    await running.again();
    expect(running.threads().rows).toEqual([]);
    running.quit();

    const later = await launch();
    expect(later.threads().rows).toEqual([]);
    later.quit();
  });

  it("does not bring back Project names a computer no longer has", async () => {
    pairedWith("key-1");
    phone.inbox = { rows: [row], reachable: true };
    (await launch()).quit();

    phone.inbox = { rows: [], reachable: true };
    phone.projects = [];
    const later = await launch();
    expect(later.threads().projects).toEqual([]);
    later.quit();
  });
});
