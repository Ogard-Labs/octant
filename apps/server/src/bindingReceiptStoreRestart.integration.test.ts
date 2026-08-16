import { decodeBindingReceiptId, decodeWindowId } from "@octant/contracts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BINDING_RECEIPT_TTL_MS,
  BindingReceiptError,
  DurableBindingReceiptStore,
} from "./bindingReceiptStore";
import { applyMigrations, MIGRATIONS } from "./persistence/migrations";
import { openSqlite } from "./persistence/sqlitePort";

const directories: Array<string> = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const firstWindow = decodeWindowId("00000000-0000-4000-8000-000000000511");
const binding = { canonicalRoot: "/private/tmp/project" } as const;

describe("DurableBindingReceiptStore restart", () => {
  it("restores an unconsumed receipt after restart and keeps one-time consume semantics", () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-receipt-restart-"));
    directories.push(directory);
    const path = join(directory, "octant.sqlite3");

    const first = openSqlite(path);
    applyMigrations(first, MIGRATIONS, () => "2026-07-25T10:00:00.000Z");
    const firstStore = new DurableBindingReceiptStore(first);
    const receipt = firstStore.issue({
      windowId: firstWindow,
      projectType: "work",
      canonicalBinding: binding,
      now: 1_000,
    });
    expect(decodeBindingReceiptId(receipt.receiptId)).toBe(receipt.receiptId);
    first.close();

    const reopened = openSqlite(path);
    applyMigrations(reopened, MIGRATIONS, () => "2026-07-25T10:00:00.000Z");
    const restartedStore = new DurableBindingReceiptStore(reopened);

    expect(
      restartedStore.consume({
        receiptId: receipt.receiptId,
        authenticatedWindowId: firstWindow,
        projectType: "work",
        now: 1_001,
      }),
    ).toEqual(binding);

    expect(() =>
      restartedStore.consume({
        receiptId: receipt.receiptId,
        authenticatedWindowId: firstWindow,
        projectType: "work",
        now: 1_002,
      }),
    ).toThrow(BindingReceiptError);
    reopened.close();
  });

  it("expires a restored receipt after the TTL elapses across restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-receipt-restart-ttl-"));
    directories.push(directory);
    const path = join(directory, "octant.sqlite3");

    const first = openSqlite(path);
    applyMigrations(first, MIGRATIONS, () => "2026-07-25T10:00:00.000Z");
    const firstStore = new DurableBindingReceiptStore(first);
    const receipt = firstStore.issue({
      windowId: firstWindow,
      projectType: "code",
      canonicalBinding: binding,
      now: 0,
    });
    first.close();

    const reopened = openSqlite(path);
    applyMigrations(reopened, MIGRATIONS, () => "2026-07-25T10:00:00.000Z");
    const restartedStore = new DurableBindingReceiptStore(reopened);

    expect(() =>
      restartedStore.consume({
        receiptId: receipt.receiptId,
        authenticatedWindowId: firstWindow,
        projectType: "code",
        now: BINDING_RECEIPT_TTL_MS,
      }),
    ).toThrow(BindingReceiptError);
    reopened.close();
  });
});
