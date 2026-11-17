import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useEvenReveal } from "./useEvenReveal";

beforeEach(() => {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "performance",
      "requestAnimationFrame",
      "cancelAnimationFrame",
    ],
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

const words = (count: number) =>
  Array.from({ length: count }, (_, i) => `word${i}`).join(" ") + " ";

it("shows what is already there when mounted mid-stream and paces only new text", () => {
  const start = words(40);
  const view = renderHook((props) => useEvenReveal(props.body, true), {
    initialProps: { body: start },
  });
  expect(view.result.current).toBe(start);
  const grown = start + words(40);
  view.rerender({ body: grown });
  expect(view.result.current).toBe(start);
  advance(48);
  expect(view.result.current.length).toBeGreaterThan(start.length);
  expect(view.result.current.length).toBeLessThan(grown.length);
});

it("shows the first content immediately", () => {
  const view = renderHook((props) => useEvenReveal(props.body, true), {
    initialProps: { body: "" },
  });
  view.rerender({ body: "Hello there, a first burst." });
  expect(view.result.current).toBe("Hello there, a first burst.");
});

it("reveals bursts at an even rate", () => {
  let body = words(5);
  const view = renderHook((props) => useEvenReveal(props.body, true), {
    initialProps: { body },
  });
  const lengths: number[] = [];
  // About 140 characters in a burst every 192 ms.
  for (let burst = 0; burst < 10; burst += 1) {
    body += words(20);
    view.rerender({ body });
    for (let frame = 0; frame < 12; frame += 1) {
      advance(16);
      lengths.push(view.result.current.length);
    }
  }
  const steps = lengths.slice(1).map((length, i) => length - (lengths[i] ?? 0));
  expect(steps.every((step) => step >= 0)).toBe(true);
  expect(steps.filter((step) => step > 0).length).toBeGreaterThan(20);
  // No step dumps a whole burst.
  expect(Math.max(...steps)).toBeLessThan(60);
  // Text keeps coming between bursts, not only when one lands.
  expect(new Set(lengths.slice(100, 112)).size).toBeGreaterThan(3);
});

it("reveals whole words where it can", () => {
  const body = "start " + words(30);
  const view = renderHook((props) => useEvenReveal(props.body, true), {
    initialProps: { body: "start " },
  });
  view.rerender({ body });
  for (let frame = 0; frame < 20; frame += 1) {
    advance(16);
    const shown = view.result.current;
    expect(shown.endsWith(" ") || /\bword\d+$/u.test(shown) || shown === "start").toBe(true);
    expect(shown).not.toMatch(/\bwor?d?$/u);
  }
});

it("drains the rest within 100 ms when the stream ends", () => {
  const body = "x " + words(60);
  const view = renderHook((props) => useEvenReveal(props.body, props.streaming), {
    initialProps: { body: "x ", streaming: true },
  });
  view.rerender({ body, streaming: true });
  advance(32);
  expect(view.result.current.length).toBeLessThan(body.length);
  view.rerender({ body, streaming: false });
  advance(100);
  expect(view.result.current).toBe(body);
});

it("skips ahead when it falls far behind", () => {
  const body = "x " + words(2000);
  const view = renderHook((props) => useEvenReveal(props.body, true), {
    initialProps: { body: "x " },
  });
  view.rerender({ body });
  // A long answer steps every 100 ms.
  advance(120);
  // Pacing alone would have revealed a few dozen characters by now.
  expect(view.result.current.length).toBeGreaterThan(body.length - 200);
});

it("shows a replacement or shrunk text immediately", () => {
  const view = renderHook((props) => useEvenReveal(props.body, true), {
    initialProps: { body: words(10) },
  });
  view.rerender({ body: words(20) });
  view.rerender({ body: "Rewritten." });
  expect(view.result.current).toBe("Rewritten.");
  advance(100);
  expect(view.result.current).toBe("Rewritten.");
});

it("shows text as it arrives under reduced motion", () => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  const view = renderHook((props) => useEvenReveal(props.body, true), {
    initialProps: { body: "a " },
  });
  view.rerender({ body: "a " + words(50) });
  expect(view.result.current).toBe("a " + words(50));
});
