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
    /** Reads the key store refuses next, as it may while the phone is locked. */
    secureFailures: 0,
    files: new Map<string, string>(),
    session: undefined as unknown,
    inbox: {
      rows: [] as ReadonlyArray<unknown>,
      reachable: true,
      /** Computers that cannot be reached while the others answer. */
      offline: [] as ReadonlyArray<string>,
    },
    projects: [{ projectId: "travel", name: "Travel" }] as ReadonlyArray<unknown>,
    // The shared packages are the same through a restart, and slow to load again.
    runtime: undefined as typeof import("@octant/client-runtime") | undefined,
    contracts: undefined as typeof import("@octant/contracts") | undefined,
  };
});

vi.mock("../hosts/expoSecureStorage", () => ({
  createExpoSecureStringStorage: () => ({
    getItem: async (key: string) => {
      if (phone.secureFailures > 0) {
        phone.secureFailures -= 1;
        throw new Error("The key store did not answer.");
      }
      return phone.secure.get(key) ?? null;
    },
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
        ? {
            rows: phone.inbox.rows.filter(
              (entry) => !phone.inbox.offline.includes((entry as MobileInboxRow).hostId),
            ),
            failures: transports
              .filter(({ hostId }) => phone.inbox.offline.includes(hostId))
              .map(({ hostId }) => ({
                hostId,
                category: "offline",
                message: "The computer cannot be reached.",
              })),
          }
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
const laptop = "22222222-2222-4222-8222-222222222222";
function pairedWith(hostKeyFingerprint: string, alsoLaptop = false) {
  phone.session = {
    environment: { kind: "live" },
    hosts: [
      { hostId: studio, label: "Studio Mac", hostKeyFingerprint, keyId: "device-key" },
      ...(alsoLaptop
        ? [{ hostId: laptop, label: "Laptop", hostKeyFingerprint: "key-l", keyId: "device-key" }]
        : []),
    ],
    hostsLoaded: true,
    hostsError: undefined,
    health: [],
    transports: alsoLaptop ? [transport, { ...transport, hostId: laptop }] : [transport],
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
    phone.inbox = { rows: [row], reachable: true, offline: [] };
    const first = await launch();
    expect(first.threads().rows.map((entry) => entry.threadId)).toEqual(["plan-the-trip"]);
    first.quit();
    expect([...phone.files.values()].join("")).not.toContain("Plan the trip");

    phone.inbox = { rows: [], reachable: false, offline: [] };
    const later = await launch();
    const [kept] = later.threads().rows;
    expect(kept?.title).toBe("Plan the trip");
    expect(kept?.live).toBeUndefined();
    expect(kept === undefined ? undefined : later.threads().projectName(kept)).toBe("Travel");
    later.quit();
  });

  it("still lets a message wait for a computer that said this phone may write there", async () => {
    pairedWith("key-1");
    phone.inbox = { rows: [row], reachable: true, offline: [] };
    const first = await launch();
    await act(async () => first.threads().noteStanding(studio, { actsAsHostPerson: true }));
    // Read the kept list as the app does, and wait until it holds the
    // standing: which of the app's writes landed last cannot be told apart
    // from outside, but what was kept can.
    const keptText = async () => {
      const { createSealedText } = await import("../outbox/sealedText");
      const { createExpoSecureStringStorage } = await import("../hosts/expoSecureStorage");
      const { sealedFile } = await import("../outbox/sealedFile");
      return createSealedText({
        storage: createExpoSecureStringStorage(),
        file: sealedFile("threads.v1.sealed"),
        keyName: "octant.threads.key.v1",
        crypto: globalThis.crypto,
      }).load();
    };
    for (let turn = 0; turn < 400; turn += 1) {
      if ((await keptText())?.includes("actsAsHostPerson") === true) break;
      await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 5)));
    }
    expect(await keptText()).toContain("actsAsHostPerson");
    first.quit();

    phone.inbox = { rows: [], reachable: false, offline: [] };
    const later = await launch();
    expect(later.threads().lastStanding(studio)).toEqual({ actsAsHostPerson: true });
    later.quit();

    pairedWith("key-2");
    const repaired = await launch();
    expect(repaired.threads().lastStanding(studio)).toBeUndefined();
    repaired.quit();
  });

  it("is kept, not written over, through a run that could not read it", async () => {
    pairedWith("key-1", true);
    phone.inbox = { rows: [row], reachable: true, offline: [] };
    (await launch()).quit();

    // Its first read fails, the key store answers again, and the laptop answers
    // while the studio is out of reach.
    const laptopRow = { ...row, hostId: laptop, threadId: "pack" };
    phone.inbox = { rows: [laptopRow], reachable: true, offline: [studio] };
    phone.secureFailures = 1;
    try {
      (await launch()).quit();
    } finally {
      phone.secureFailures = 0;
    }
    phone.inbox = { rows: [], reachable: false, offline: [] };
    const later = await launch();
    expect(later.threads().rows.map((entry) => entry.threadId)).toContain("plan-the-trip");
    later.quit();
  });

  it("comes back in the same run once a failed read is read again", async () => {
    pairedWith("key-1");
    phone.inbox = { rows: [row], reachable: true, offline: [] };
    (await launch()).quit();

    phone.inbox = { rows: [], reachable: false, offline: [] };
    phone.secureFailures = 1;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const later = await launch();
      expect(later.threads().rows).toEqual([]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      await later.again();
      expect(later.threads().rows.map((entry) => entry.threadId)).toEqual(["plan-the-trip"]);
      later.quit();
    } finally {
      vi.useRealTimers();
      phone.secureFailures = 0;
    }
  });

  it("gives way to what the computer says once it answers", async () => {
    pairedWith("key-1");
    phone.inbox = { rows: [row], reachable: true, offline: [] };
    (await launch()).quit();

    phone.inbox = { rows: [], reachable: true, offline: [] };
    const later = await launch();
    expect(later.threads().rows).toEqual([]);
    later.quit();
  });

  it("is not shown for a computer paired again under another key", async () => {
    pairedWith("key-1");
    phone.inbox = { rows: [row], reachable: true, offline: [] };
    (await launch()).quit();

    pairedWith("key-2");
    phone.inbox = { rows: [], reachable: false, offline: [] };
    const later = await launch();
    expect(later.threads().rows).toEqual([]);
    later.quit();
  });

  it("keeps nothing read under a pairing the computer was paired again from, while the app runs", async () => {
    pairedWith("key-1");
    phone.inbox = { rows: [row], reachable: true, offline: [] };
    const running = await launch();
    phone.inbox = { rows: [], reachable: false, offline: [] };
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
    phone.inbox = { rows: [row], reachable: true, offline: [] };
    (await launch()).quit();

    phone.inbox = { rows: [], reachable: true, offline: [] };
    phone.projects = [];
    const later = await launch();
    expect(later.threads().projects).toEqual([]);
    later.quit();
  });
});
