import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeLinearAccountRef,
  createFileLinearAccountIndexStore,
  type LinearAccountIndex,
} from "./linearAccountIndexStore";

const tempDirs: string[] = [];

function makeTempFile(name = "linear-accounts.json"): string {
  const dir = mkdtempSync(join(tmpdir(), "octant-linear-index-"));
  tempDirs.push(dir);
  return join(dir, name);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Linear account index store", () => {
  it("writes the index atomically with 0600 permissions and reads it back", () => {
    const filePath = makeTempFile();
    const store = createFileLinearAccountIndexStore(filePath);
    expect(store.read()).toEqual({ kind: "absent" });

    const accountRef = computeLinearAccountRef("viewer-a", "org-a");
    const index: LinearAccountIndex = {
      version: 1,
      legacyRef: accountRef,
      accounts: [
        {
          accountRef,
          viewerId: "viewer-a",
          workspaceId: "org-a",
          login: "acme",
          displayName: "Ada",
          workspace: "Acme",
          source: "oauth",
          scopes: ["read", "write"],
          vaultId: "11111111-1111-4111-8111-111111111111",
          reconnectRequired: false,
        },
      ],
    };
    expect(store.write(index)).toEqual({ kind: "written" });
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
    expect(store.read()).toEqual({ kind: "ok", index });
  });

  it("reports a damaged index without overwriting it and refuses secret-shaped labels", () => {
    const filePath = makeTempFile();
    writeFileSync(filePath, "{not valid json", { mode: 0o600 });
    const store = createFileLinearAccountIndexStore(filePath);
    expect(store.read()).toMatchObject({ kind: "damaged" });

    expect(
      store.write({
        version: 1,
        accounts: [
          {
            accountRef: computeLinearAccountRef("viewer-a", "org-a"),
            login: "lin_api_secret_leaked",
            source: "personal-api-key",
            scopes: ["read"],
            vaultId: "22222222-2222-4222-8222-222222222222",
            reconnectRequired: false,
          },
        ],
      }),
    ).toMatchObject({ kind: "failed" });
  });
});
