import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  decodeOwnerBrowserNativeCommand,
  OwnerBrowserNativeTarget,
  type OwnerBrowserInput,
} from "@octant/contracts/owner-browser";
import { BrowserOwnerControl, type OwnerControlPage } from "./browserOwnerControl";

const resource = {
  contextId: "a7880000-0000-4000-8000-000000000001",
  owner: {
    windowId: "a7880000-0000-4000-8000-000000000002",
    threadId: "a7880000-0000-4000-8000-000000000003",
  },
};
const id = "a7880000-0000-4000-8000-000000000004";
const target = Schema.decodeUnknownSync(OwnerBrowserNativeTarget)({
  targetVersion: "a".repeat(64),
  documentRevision: 1,
  origin: "https://fixture.invalid",
});
function fixture() {
  let now = 0;
  let inputs = 0;
  let epoch = 0;
  let privateHeld = false;
  let delayed = false;
  let delayInput = false;
  const inputStarted = Promise.withResolvers<void>();
  const inputSettled = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const capture = Promise.withResolvers<void>();
  const effects: OwnerBrowserInput[] = [];
  const identity = {};
  const controller = new BrowserOwnerControl({
    now: () => now,
    page: () =>
      ({
        identity,
        target,
        personInputs: inputs,
        width: 800,
        height: 600,
        capture: async () => {
          started.resolve();
          if (delayed) await capture.promise;
          return {
            isEmpty: () => false,
            getSize: () => ({ width: 800, height: 600 }),
            toJPEG: () => new Uint8Array([1, 2]),
          };
        },
        input: async (input, _width, _height, current) => {
          inputs += 1;
          effects.push(input);
          inputStarted.resolve();
          if (delayInput) await inputSettled.promise;
          if (!current()) throw new Error("Synthetic control ended after dispatch");
        },
        observe: () => {
          const at = epoch;
          const check = () => {
            if (privateHeld || at !== epoch) throw new Error("Private custody changed");
          };
          check();
          return check;
        },
      }) satisfies OwnerControlPage,
  });
  const run = (command: Readonly<Record<string, unknown>>) =>
    controller.execute(decodeOwnerBrowserNativeCommand({ ...resource, ...command }));
  return {
    controller,
    effects,
    started: started.promise,
    run,
    active: () => controller.active(identity),
    inputStarted: inputStarted.promise,
    delayInput: () => {
      delayInput = true;
    },
    settleInput: () => inputSettled.resolve(),
    observe: () => controller.observation(identity),
    claim: () =>
      run({ operation: "claim", controlId: id, target, expiresAt: "1970-01-01T00:01:00.000Z" }),
    delay: () => {
      delayed = true;
    },
    releaseCapture: () => capture.resolve(),
    private: (value: boolean) => {
      privateHeld = value;
      epoch += 1;
    },
    expire: () => {
      now = 60_000;
    },
    localInput: () => {
      inputs += 1;
      controller.reclaim(identity);
    },
  };
}

describe("volatile owner Browser native control", () => {
  it("requires a current person frame and consumes input once, with expiry independent of timer delivery", async () => {
    const f = fixture();
    expect((await f.claim()).status).toBe("claimed");
    expect(
      (
        await f.run({
          operation: "input",
          controlId: id,
          sequence: 1,
          expectedFrame: 1,
          input: { kind: "press", key: "Enter" },
        })
      ).status,
    ).toBe("refused");
    expect((await f.run({ operation: "frame", controlId: id, sequence: 1 })).status).toBe("frame");
    expect(
      await f.run({
        operation: "input",
        controlId: id,
        sequence: 2,
        expectedFrame: 1,
        input: { kind: "type", text: "synthetic" },
      }),
    ).toEqual({ status: "input", effect: "completed" });
    expect(
      (
        await f.run({
          operation: "input",
          controlId: id,
          sequence: 3,
          expectedFrame: 1,
          input: { kind: "press", key: "Enter" },
        })
      ).status,
    ).toBe("refused");
    f.expire();
    expect((await f.run({ operation: "frame", controlId: id, sequence: 3 })).status).toBe(
      "refused",
    );
    expect(f.effects).toHaveLength(1);
    f.controller.close();
  });

  it("withholds an overlapping frame even after private custody has released", async () => {
    const f = fixture();
    await f.claim();
    f.delay();
    const pending = f.run({ operation: "frame", controlId: id, sequence: 1 });
    await f.started;
    f.private(true);
    f.private(false);
    f.releaseCapture();
    expect(await pending).toEqual({ status: "refused" });
    expect(f.effects).toHaveLength(0);
    f.controller.close();
  });

  it("revokes remote input when the local person reclaims and never releases another controller", async () => {
    const f = fixture();
    await f.claim();
    await f.run({ operation: "frame", controlId: id, sequence: 1 });
    f.localInput();
    expect(f.active()).toBe(false);
    expect(
      (
        await f.run({
          operation: "input",
          controlId: id,
          sequence: 2,
          expectedFrame: 1,
          input: { kind: "press", key: "Enter" },
        })
      ).status,
    ).toBe("refused");
    expect(f.effects).toHaveLength(0);
    f.controller.close();
  });

  it("refuses a hand-back after the local person reclaimed the page but still cleans up on revoke", async () => {
    const f = fixture();
    await f.claim();
    await f.run({ operation: "frame", controlId: id, sequence: 1 });
    f.localInput();
    expect(await f.run({ operation: "release", controlId: id, disposition: "hand-back" })).toEqual({
      status: "refused",
    });
    expect(await f.run({ operation: "release", controlId: id, disposition: "revoke" })).toEqual({
      status: "released",
    });
    expect((await f.claim()).status).toBe("claimed");
    expect(await f.run({ operation: "release", controlId: id, disposition: "hand-back" })).toEqual({
      status: "released",
    });
    f.controller.close();
  });

  it("revokes authority without confirming cleanup while native input is still outstanding", async () => {
    const f = fixture();
    await f.claim();
    await f.run({ operation: "frame", controlId: id, sequence: 1 });
    f.delayInput();
    const pending = f.run({
      operation: "input",
      controlId: id,
      sequence: 2,
      expectedFrame: 1,
      input: { kind: "tap", x: 0.5, y: 0.5 },
    });
    await f.inputStarted;
    expect(await f.run({ operation: "release", controlId: id, disposition: "revoke" })).toEqual({
      status: "refused",
    });
    expect(f.active()).toBe(false);
    expect(() => f.observe()).toThrow("holds agent observations");
    expect((await f.claim()).status).toBe("refused");
    f.settleInput();
    expect(await pending).toEqual({ status: "input", effect: "possible" });
    expect(await f.run({ operation: "release", controlId: id, disposition: "revoke" })).toEqual({
      status: "released",
    });
    expect(() => f.observe()).not.toThrow();
    expect((await f.claim()).status).toBe("claimed");
    f.controller.close();
  });
});
