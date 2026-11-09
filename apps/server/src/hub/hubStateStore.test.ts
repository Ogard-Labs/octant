import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDelegationStateStore } from "./delegationStateStore";
import { createTailscaleCertificateSetting } from "./tailscaleCertificate";
import { createHubStateStore } from "./hubStateStore";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function feed(named: boolean) {
  return {
    schemaVersion: 1,
    release: {
      ...(named ? { product: "octant" } : {}),
      version: "1.4.0",
      platform: "darwin",
      arch: "arm64",
      ring: "candidate",
      url: "https://updates.example.test/octant-1.4.0.zip",
      sha256: "b".repeat(64),
      releasedAt: "2026-10-29T12:00:00.000Z",
    },
    signature: `${"A".repeat(86)}==`,
  };
}

function stateWith(mirrorFeed: unknown) {
  return {
    hub: {
      enabled: true,
      members: [],
      joinTickets: [],
      provision: {
        enabled: true,
        offers: [
          {
            offerId: "6f1f1d1e-7a0b-4c9e-9a51-0d3c2b1a0f00",
            createdAt: 1,
            offer: { kind: "update-channel", channel: "candidate", mirror: true },
            mirrorFeed,
            deliveries: [],
          },
        ],
      },
    },
  };
}

/** A store whose file holds `state` as written by an earlier build. */
function storeHolding(state: unknown) {
  const dataDirectory = mkdtempSync(join(tmpdir(), "octant-hub-state-"));
  directories.push(dataDirectory);
  const store = createHubStateStore(dataDirectory);
  store.save({});
  const file = readdirSync(dataDirectory, { recursive: true, withFileTypes: true }).find((entry) =>
    entry.isFile(),
  );
  if (file === undefined) throw new Error("The hub state store wrote no file.");
  writeFileSync(join(file.parentPath, file.name), JSON.stringify(state));
  return store;
}

describe("the stored hub state", () => {
  it("keeps the hub when a mirrored feed saved before releases named their app no longer reads", () => {
    const loaded = storeHolding(stateWith(feed(false))).load();

    expect(loaded.hub?.enabled).toBe(true);
    expect(loaded.hub?.provision?.offers).toHaveLength(1);
    expect(loaded.hub?.provision?.offers[0]).not.toHaveProperty("mirrorFeed");
  });

  it("keeps a mirrored feed that names its app", () => {
    const loaded = storeHolding(stateWith(feed(true))).load();

    expect(loaded.hub?.provision?.offers[0]?.mirrorFeed?.release.product).toBe("octant");
  });
});

describe("private native authority records", () => {
  for (const [name, create, empty] of [
    ["hub", createHubStateStore, {}],
    ["delegations", createDelegationStateStore, { received: [], sent: [] }],
    ["certificate", createTailscaleCertificateSetting, { enabled: false }],
  ] as const) {
    it(`refuses an unsafe ${name} record instead of resetting authority`, () => {
      const store = create("native-only", {
        dataDirectory: "native-only",
        read: () => ({ status: "refused" as const }),
        replace: () => ({ status: "committed" as const }),
      });
      expect(() => store.load()).toThrow("authority state");
    });
    it(`uses the existing ${name} default only for a positively missing native record`, () => {
      const store = create("native-only", {
        dataDirectory: "native-only",
        read: () => ({ status: "missing" as const }),
        replace: () => ({ status: "committed" as const }),
      });
      expect(store.load()).toEqual(empty);
    });
  }
});

it("refuses corrupt UTF-8 and schema data without replacing the native record", () => {
  for (const bytes of [Buffer.from([0xff]), Buffer.from("{"), Buffer.from('{"unexpected":true}')]) {
    let replaced = false;
    const store = createHubStateStore("native-only", {
      dataDirectory: "native-only",
      read: () => ({ status: "ready", bytes: Buffer.from(bytes) }),
      replace: () => {
        replaced = true;
        return { status: "committed" };
      },
    });
    expect(() => store.load()).toThrow("authority state");
    expect(() => store.save({})).toThrow("authority state");
    expect(replaced).toBe(false);
  }
});
it("round-trips native revocations and erases each owned encoded transfer", () => {
  let saved: Buffer | undefined;
  const transfers: Buffer[] = [];
  const store = createHubStateStore("native-only", {
    dataDirectory: "native-only",
    read: () =>
      saved === undefined ? { status: "missing" } : { status: "ready", bytes: Buffer.from(saved) },
    replace: (bytes) => {
      saved = Buffer.from(bytes);
      transfers.push(bytes);
      return { status: "committed" };
    },
  });
  const state = {
    pendingDeviceRevocations: ["11111111-1111-4111-8111-111111111111"],
    ownerUnlockBeforePairedMerge: true,
  } as const;
  store.save(state);
  expect(store.load()).toEqual(state);
  expect(transfers.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
});
