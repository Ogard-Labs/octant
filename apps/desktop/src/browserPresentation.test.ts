import { describe, expect, it, vi } from "vitest";
import { BrowserPresentation } from "./browserPresentation";

function setup() {
  let valid = true;
  let receive:
    | ((image: { getSize(): { width: number; height: number }; toJPEG(): Uint8Array }) => void)
    | undefined;
  const visible = vi.fn();
  const input = vi.fn();
  const remove = vi.fn();
  const source = {
    visible,
    input,
    bounds: vi.fn(),
    frames: (listener: NonNullable<typeof receive>) => {
      receive = listener;
      return remove;
    },
  };
  const presentation = new BrowserPresentation();
  const id = presentation.attach(source, () => valid);
  presentation.layout(id, { width: 800, height: 600, visible: true });
  const image = (value: number, width = 800) => ({
    getSize: () => ({ width, height: 600 }),
    toJPEG: vi.fn(() => new Uint8Array([value])),
  });
  return {
    presentation,
    id,
    source,
    image,
    offer: (value: ReturnType<typeof image>) => receive?.(value),
    expire: () => {
      valid = false;
    },
  };
}

describe("embedded human presentation", () => {
  it("admits current input before asynchronous cleanup without accepting initially stale coordinates", () => {
    const s = setup();
    s.offer(s.image(1));
    s.presentation.frame(s.id, 0);
    const down = { type: "mouseDown", x: 10, y: 20, button: "left", clickCount: 1 } as const;
    const admitted = s.presentation.reserveInput(s.id, down, 1);
    s.offer(s.image(2));
    s.presentation.frame(s.id, 1);
    expect(s.presentation.reserveInput(s.id, down, 1)).toBeUndefined();
    expect(admitted?.()).toBe(true);
    expect(admitted?.()).toBe(false);
    const retired = s.presentation.reserveInput(s.id, down, 2);
    s.presentation.layout(s.id, { width: 700, height: 600, visible: true });
    expect(retired?.()).toBe(false);
    s.offer(s.image(3, 700));
    s.presentation.frame(s.id, 2);
    const expired = s.presentation.reserveInput(s.id, down, 3);
    s.expire();
    expect(expired?.()).toBe(false);
    expect(s.source.input).toHaveBeenCalledOnce();
  });

  it("keeps the displayed frame current when the hidden page capture is unchanged", () => {
    const s = setup();
    s.offer(s.image(1));
    s.presentation.frame(s.id, 0);
    s.offer(s.image(1));
    expect(s.presentation.frame(s.id, 1)).toEqual({ status: "idle" });
    expect(
      s.presentation.input(
        s.id,
        { type: "mouseDown", x: 10, y: 20, button: "left", clickCount: 1 },
        1,
      ),
    ).toBe(true);
    s.offer(s.image(2));
    expect(s.presentation.frame(s.id, 1)).toMatchObject({ status: "frame", sequence: 2 });
  });
  it("retains only the newest pending image and requires the exact frame acknowledgement", () => {
    const s = setup();
    const first = s.image(1);
    s.offer(first);
    expect(s.presentation.frame(s.id, 0)).toMatchObject({ status: "frame", sequence: 1 });
    const discarded = s.image(2);
    s.offer(discarded);
    s.offer(s.image(3));
    expect(s.presentation.frame(s.id, 0)).toMatchObject({ status: "frame", sequence: 1 });
    expect(s.presentation.frame(s.id, 99)).toEqual({ status: "refused" });
    expect(discarded.toJPEG).not.toHaveBeenCalled();
    expect(s.presentation.frame(s.id, 1)).toMatchObject({
      status: "frame",
      sequence: 2,
      dataUrl: "data:image/jpeg;base64,Aw==",
    });
  });

  it("discards pending pixels and hides before accepting expired input", () => {
    const s = setup();
    const image = s.image(1);
    s.offer(image);
    s.expire();
    expect(s.presentation.frame(s.id, 0)).toEqual({ status: "refused" });
    expect(image.toJPEG).not.toHaveBeenCalled();
    expect(s.presentation.visible).toBe(false);
    expect(s.presentation.input(s.id, { type: "char", keyCode: "a" }, 1)).toBe(false);
    expect(s.source.input).not.toHaveBeenCalled();
    expect(s.source.visible).toHaveBeenLastCalledWith(false);
  });

  it("releases accepted input across frame advance without admitting new stale clicks", () => {
    const s = setup();
    s.offer(s.image(1));
    s.presentation.frame(s.id, 0);
    expect(s.presentation.input(s.id, { type: "keyDown", keyCode: "a" }, 1)).toBe(true);
    expect(
      s.presentation.input(
        s.id,
        { type: "mouseDown", x: 10, y: 20, button: "left", clickCount: 1 },
        1,
      ),
    ).toBe(true);
    s.offer(s.image(2));
    s.presentation.frame(s.id, 1);
    s.offer(s.image(3));
    s.presentation.frame(s.id, 2);
    expect(
      s.presentation.input(
        s.id,
        { type: "mouseDown", x: 300, y: 400, button: "right", clickCount: 1 },
        1,
      ),
    ).toBe(false);
    expect(s.presentation.input(s.id, { type: "keyUp", keyCode: "a" }, 1)).toBe(true);
    expect(
      s.presentation.input(
        s.id,
        { type: "mouseUp", x: 300, y: 400, button: "left", clickCount: 1 },
        1,
      ),
    ).toBe(true);
    expect(s.source.input).toHaveBeenLastCalledWith({
      type: "mouseUp",
      x: -1,
      y: -1,
      button: "left",
      clickCount: 1,
    });
    expect(
      s.presentation.input(
        s.id,
        { type: "mouseUp", x: 10, y: 20, button: "left", clickCount: 1 },
        1,
      ),
    ).toBe(false);
  });

  it("accepts the Enter character only while its matching key is held across frame advance", () => {
    const s = setup();
    s.offer(s.image(1));
    s.presentation.frame(s.id, 0);
    expect(s.presentation.input(s.id, { type: "char", keyCode: "\r" }, 1)).toBe(false);
    expect(s.presentation.input(s.id, { type: "keyDown", keyCode: "Enter" }, 1)).toBe(true);
    s.offer(s.image(2));
    s.presentation.frame(s.id, 1);
    expect(s.presentation.input(s.id, { type: "char", keyCode: "\r" }, 1)).toBe(true);
    expect(s.presentation.input(s.id, { type: "keyUp", keyCode: "Enter" }, 1)).toBe(true);
    expect(s.presentation.input(s.id, { type: "char", keyCode: "\r" }, 2)).toBe(false);
  });

  it("clears ownership and attempts both cleanup operations when observers throw", () => {
    const s = setup();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const source = {
        ...s.source,
        frames: () => () => {
          throw new Error("remove failed");
        },
      };
      const id = s.presentation.attach(source, () => true);
      s.source.visible.mockImplementation(() => {
        throw new Error("hide failed");
      });
      expect(s.presentation.detach(id)).toBe(false);
      expect(s.presentation.visible).toBe(false);
      expect(s.presentation.frame(id, 0)).toEqual({ status: "refused" });
      expect(s.source.visible).toHaveBeenLastCalledWith(false);
      expect(warning).toHaveBeenCalledOnce();
    } finally {
      warning.mockRestore();
    }
  });

  it("does not let a retired detach hide a successor or publish hidden or oversized pixels", () => {
    const s = setup();
    const next = s.presentation.attach(s.source, () => true);
    s.presentation.layout(next, { width: 800, height: 600, visible: true });
    expect(s.presentation.detach(s.id)).toBe(false);
    expect(s.presentation.visible).toBe(true);
    const malformed = s.image(9, NaN);
    s.offer(malformed);
    expect(malformed.toJPEG).not.toHaveBeenCalled();
    const oversized = s.image(9, 9000);
    s.offer(oversized);
    expect(s.presentation.frame(next, 0)).toEqual({ status: "idle" });
    expect(oversized.toJPEG).not.toHaveBeenCalled();
    s.presentation.layout(next, { width: 800, height: 600, visible: false });
    s.offer(s.image(8));
    expect(s.presentation.frame(next, 0)).toEqual({ status: "refused" });
    expect(s.presentation.input(next, { type: "char", keyCode: "a" }, 1)).toBe(false);
  });
});
