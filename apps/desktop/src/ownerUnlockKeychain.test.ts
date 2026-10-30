import { ownerUnlockSigningPayload } from "@octant/domain";
import { describe, expect, it } from "vitest";
import type { HostSigningHelperSpec, KeychainHelperExecutor } from "./hostIdentityKeychain";
import {
  OWNER_UNLOCK_KEYCHAIN_NAMESPACE,
  makeOwnerUnlockKeyService,
  type OwnerUnlockChallenge,
} from "./ownerUnlockKeychain";

const helperPath = "/Applications/Octant.app/Contents/Resources/native/octant-keychain-helper";
const storeScope = "7d444840-9dc0-41d1-b245-5ffdce74fad2";
const signature = "A".repeat(86);

const challenge: OwnerUnlockChallenge = {
  challengeId: "00000000-0000-4000-8000-000000000006",
  nonce: "bm9uY2U",
  hostMemberId: "00000000-0000-4000-8000-000000000002",
  ownerMemberId: "00000000-0000-4000-8000-000000000003",
  method: "POST",
  path: "/api/hub/owner/session",
  bodyHash: "b".repeat(64),
  expiresAt: 1_790_000_060_000,
};

const answer = (body: Record<string, unknown>, exitCode = 0) => ({
  exitCode,
  stdout: `${JSON.stringify({ version: 1, ...body })}\n`,
  stderr: "",
});

/** A native helper that holds one key: makes it, signs once present, forgets it. */
function fakeEnclave(options: { readonly enclave?: boolean; readonly decline?: boolean } = {}) {
  const requests: Array<Record<string, unknown>> = [];
  let held = false;
  const execute: KeychainHelperExecutor = async (spec: HostSigningHelperSpec) => {
    const request = JSON.parse(spec.stdin) as Record<string, unknown>;
    requests.push(request);
    if (options.enclave === false) return answer({ ok: false, error: "unavailable" }, 1);
    if (request.operation === "make") {
      held = true;
      return answer({ ok: true, operation: "make", publicKey: "cHVibGljLWtleQ" });
    }
    if (request.operation === "sign") {
      if (!held) return answer({ ok: false, error: "missing" }, 1);
      if (options.decline === true) return answer({ ok: false, error: "cancelled" }, 1);
      return answer({ ok: true, operation: "sign", signature });
    }
    held = false;
    return answer({ ok: true, operation: "forget" });
  };
  return { execute, requests };
}

describe("a Mac owner device's unlock key", () => {
  it("makes a key, signs one owner unlock, and forgets the key", async () => {
    const { execute, requests } = fakeEnclave();
    const service = makeOwnerUnlockKeyService(helperPath, { storeScope, execute });

    await expect(service.makeKey()).resolves.toEqual({
      status: "done",
      publicKey: "cHVibGljLWtleQ",
    });
    await expect(service.sign(challenge)).resolves.toEqual({ status: "done", signature });
    await expect(service.forgetKey()).resolves.toEqual({ status: "done" });
    await expect(service.sign(challenge)).resolves.toEqual({ status: "refused", kind: "no-key" });

    expect(requests.map((request) => request.operation)).toEqual([
      "make",
      "sign",
      "forget",
      "sign",
    ]);
    expect(requests.every((request) => request.namespace === OWNER_UNLOCK_KEYCHAIN_NAMESPACE)).toBe(
      true,
    );
  });

  it("hands the helper the exact unlock text built from the host's challenge", async () => {
    const { execute, requests } = fakeEnclave();
    const service = makeOwnerUnlockKeyService(helperPath, { storeScope, execute });
    await service.makeKey();
    await service.sign(challenge);

    const sent = requests.find((request) => request.operation === "sign");
    expect(Buffer.from(String(sent?.payload), "base64").toString("utf8")).toBe(
      ownerUnlockSigningPayload(challenge),
    );
  });

  it("refuses text that is not an owner unlock without reaching the helper", async () => {
    const { execute, requests } = fakeEnclave();
    const service = makeOwnerUnlockKeyService(helperPath, { storeScope, execute });
    await service.makeKey();
    requests.length = 0;

    const refused = { status: "refused", kind: "not-an-owner-unlock" };
    // A new-member confirmation is not an unlock, and neither is a path outside the owner routes.
    await expect(service.sign({ ...challenge, path: "/api/hub/join" })).resolves.toEqual(refused);
    await expect(service.sign({ ...challenge, nonce: "x\noctant-unlock-v2" })).resolves.toEqual(
      refused,
    );
    await expect(service.sign({ ...challenge, method: "DELETE" })).resolves.toEqual(refused);
    await expect(service.sign({ ...challenge, bodyHash: "not-a-hash" })).resolves.toEqual(refused);
    await expect(
      service.sign({ ...challenge, extra: "payload" } as OwnerUnlockChallenge),
    ).resolves.toEqual(refused);
    await expect(service.sign("anything at all" as never)).resolves.toEqual(refused);
    expect(requests).toEqual([]);
  });

  it("refuses on a Mac with no Secure Enclave or no password set, and makes no software key", async () => {
    const { execute, requests } = fakeEnclave({ enclave: false });
    const service = makeOwnerUnlockKeyService(helperPath, { storeScope, execute });

    await expect(service.makeKey()).resolves.toEqual({ status: "refused", kind: "unavailable" });
    await expect(service.sign(challenge)).resolves.toEqual({
      status: "refused",
      kind: "unavailable",
    });
    expect(requests.map((request) => request.operation)).toEqual(["make", "sign"]);
  });

  it("says the person declined when they cancel the Touch ID prompt", async () => {
    const { execute } = fakeEnclave({ decline: true });
    const service = makeOwnerUnlockKeyService(helperPath, { storeScope, execute });
    await service.makeKey();

    await expect(service.sign(challenge)).resolves.toEqual({
      status: "refused",
      kind: "cancelled",
    });
  });

  it("refuses an answer that carries more than a signature or malformed key material", async () => {
    const execute: KeychainHelperExecutor = async (spec) => {
      const operation = (JSON.parse(spec.stdin) as { operation: string }).operation;
      return operation === "make"
        ? answer({ ok: true, operation, publicKey: "ok", privateKey: "must-not-cross" })
        : answer({ ok: true, operation, signature: "short" });
    };
    const service = makeOwnerUnlockKeyService(helperPath, { storeScope, execute });

    await expect(service.makeKey()).resolves.toEqual({ status: "refused", kind: "failed" });
    await expect(service.sign(challenge)).resolves.toEqual({ status: "refused", kind: "failed" });
  });

  it("reports an unreachable helper as unavailable", async () => {
    const service = makeOwnerUnlockKeyService(helperPath, {
      storeScope,
      execute: async () => {
        throw new Error("spawn failed");
      },
    });

    await expect(service.makeKey()).resolves.toEqual({ status: "refused", kind: "unavailable" });
  });
});
