import { describe, expect, it } from "vitest";
import {
  decodeHumanBrowserRequest,
  decodeBrowserPresentationId,
  type HumanBrowserRequest,
  type HumanBrowserResult,
} from "@octant/contracts/browser-presentation";
import { NightlyBrowserPresentation } from "./nightlyBrowserPresentation";

const id = decodeBrowserPresentationId("00000000-0000-4000-8000-000000000801");
const owner = {
  contextId: "00000000-0000-4000-8000-000000000802",
  threadId: "00000000-0000-4000-8000-000000000803",
};
const input = (type: "keyDown" | "keyUp" | "char") => ({
  ...owner,
  presentationId: id,
  kind: "input",
  frameSequence: 1,
  input: { type, keyCode: "a" },
});

describe("Nightly main human window ownership", () => {
  it("refuses hidden, unfocused or retired owners and renderer-supplied ownership flags before dispatch", async () => {
    let visible = true;
    let focused = false;
    let current = true;
    const calls: HumanBrowserRequest[] = [];
    const main = new NightlyBrowserPresentation({
      visible: () => visible,
      focused: () => focused,
      current: () => current,
      execute: async (request) => {
        calls.push(request);
        return request.kind === "attach"
          ? { status: "attached", presentationId: id }
          : { status: "accepted" };
      },
    });
    await main.invoke({ ...owner, kind: "attach" });
    expect(await main.invoke(input("char"))).toEqual({ status: "refused" });
    expect(await main.invoke({ ...input("char"), focused: true })).toEqual({ status: "refused" });
    focused = true;
    visible = false;
    expect(await main.invoke(input("char"))).toEqual({ status: "refused" });
    visible = true;
    current = false;
    expect(await main.invoke(input("char"))).toEqual({ status: "refused" });
    expect(calls).toHaveLength(1);
    await main.close();
  });

  it("coalesces pointer floods without dropping character or release events", async () => {
    const calls: HumanBrowserRequest[] = [];
    let release: (() => void) | undefined;
    const held = new Promise<void>((done) => {
      release = done;
    });
    const main = new NightlyBrowserPresentation({
      visible: () => true,
      focused: () => true,
      current: () => true,
      execute: async (request) => {
        calls.push(request);
        if (request.kind === "attach") return { status: "attached", presentationId: id };
        if (request.kind === "frame") await held;
        return { status: "accepted" };
      },
    });
    await main.invoke({ ...owner, kind: "attach" });
    const frame = main.invoke({ ...owner, kind: "frame", presentationId: id, acknowledgement: 0 });
    await Promise.resolve();
    const moves = Array.from({ length: 100 }, (_, x) =>
      main.invoke({
        ...owner,
        kind: "input",
        presentationId: id,
        frameSequence: 1,
        input: { type: "mouseMove", x, y: 1, button: "left", clickCount: 0 },
      }),
    );
    const down = main.invoke(input("keyDown"));
    const char = main.invoke(input("char"));
    const up = main.invoke(input("keyUp"));
    release?.();
    expect(await down).toEqual({ status: "accepted" });
    expect(await char).toEqual({ status: "accepted" });
    expect(await up).toEqual({ status: "accepted" });
    await frame;
    await Promise.all(moves);
    expect(
      calls
        .filter((request) => request.kind === "input")
        .map((request) => (request.kind === "input" ? request.input.type : "")),
    ).toEqual(["mouseMove", "keyDown", "char", "keyUp"]);
    await main.close();
  });

  it("delivers every keystroke typed while a frame request is delayed", async () => {
    const calls: HumanBrowserRequest[] = [];
    let release: (() => void) | undefined;
    const held = new Promise<void>((done) => {
      release = done;
    });
    const main = new NightlyBrowserPresentation({
      visible: () => true,
      focused: () => true,
      current: () => true,
      execute: async (request) => {
        calls.push(request);
        if (request.kind === "attach") return { status: "attached", presentationId: id };
        if (request.kind === "frame") await held;
        return { status: "accepted" };
      },
    });
    await main.invoke({ ...owner, kind: "attach" });
    const frame = main.invoke({ ...owner, kind: "frame", presentationId: id, acknowledgement: 0 });
    await Promise.resolve();
    const typed = ["a", "b", "c", "d", "e"].flatMap((keyCode) =>
      (["keyDown", "char", "keyUp"] as const).map((type) =>
        main.invoke({ ...input(type), input: { type, keyCode } }),
      ),
    );
    release?.();
    expect(await Promise.all(typed)).toEqual(typed.map(() => ({ status: "accepted" })));
    await frame;
    expect(
      calls
        .filter((request) => request.kind === "input")
        .map((request) =>
          request.kind === "input" && request.input.type === "char" ? request.input.keyCode : "",
        )
        .filter((keyCode) => keyCode !== ""),
    ).toEqual(["a", "b", "c", "d", "e"]);
    await main.close();
  });

  it("hides more than four presentations without competing for the public queue", async () => {
    const hidden: string[] = [];
    const main = new NightlyBrowserPresentation({
      visible: () => true,
      focused: () => true,
      current: () => true,
      execute: async (request): Promise<HumanBrowserResult> => {
        if (request.kind === "attach") return { status: "attached", presentationId: id };
        if (request.kind === "layout" && !request.layout.visible)
          hidden.push(String(request.contextId));
        return { status: "accepted" };
      },
    });
    for (let n = 0; n < 8; n += 1)
      await main.invoke(
        decodeHumanBrowserRequest({
          ...owner,
          contextId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
          kind: "attach",
        }),
      );
    await Promise.all([main.hide(), main.hide()]);
    expect(new Set(hidden).size).toBe(8);
    expect(await main.invoke(input("char"))).toEqual({ status: "refused" });
    await main.close();
  });
});
