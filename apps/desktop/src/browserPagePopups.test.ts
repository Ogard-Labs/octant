import { decodeBrowserPagePopupId } from "@octant/contracts/browser-presentation";
import { describe, expect, it, vi } from "vitest";
import { BrowserPagePopups, type BrowserPagePopupSource } from "./browserPagePopups";

const source = (overrides: Partial<BrowserPagePopupSource> = {}) => ({
  current: vi.fn(() => true),
  answer: vi.fn(async () => true),
  dismiss: vi.fn(),
  ...overrides,
});
const select = {
  kind: "select" as const,
  anchor: { x: 0, y: 0, width: 100, height: 20 },
  options: [
    { label: "Small", disabled: false },
    { label: "Large", disabled: true },
  ],
  selectedIndex: 0,
};

describe("captured page popups", () => {
  it("answers a popup once and refuses its spent identity", async () => {
    const popups = new BrowserPagePopups();
    const page = source();
    const id = popups.offer(select, page);
    if (id === undefined) throw new Error("Expected an offered popup");
    expect(await popups.answer(id, { kind: "select", index: 0 })).toBe(true);
    expect(await popups.answer(id, { kind: "select", index: 0 })).toBe(false);
    expect(page.answer).toHaveBeenCalledTimes(1);
  });

  it("refuses a stale identity, a mismatched kind, and a disabled option", async () => {
    const popups = new BrowserPagePopups();
    const page = source();
    const id = popups.offer(select, page);
    if (id === undefined) throw new Error("Expected an offered popup");
    const stale = decodeBrowserPagePopupId("80000000-0000-4000-8000-000000000009");
    expect(await popups.answer(stale, { kind: "select", index: 0 })).toBe(false);
    expect(await popups.answer(id, { kind: "dialog", accept: true })).toBe(false);
    expect(await popups.answer(id, { kind: "select", index: 1 })).toBe(false);
    expect(await popups.answer(id, { kind: "select", index: 5 })).toBe(false);
    expect(page.answer).not.toHaveBeenCalled();
  });

  it("refuses an answer once the page that opened the popup navigated away", async () => {
    const popups = new BrowserPagePopups();
    let document = 1;
    const page = source({ current: () => document === 1 });
    const id = popups.offer({ kind: "dialog", dialog: "confirm", message: "Leave?" }, page);
    if (id === undefined) throw new Error("Expected an offered popup");
    document = 2;
    expect(await popups.answer(id, { kind: "dialog", accept: true })).toBe(false);
    expect(popups.read()).toBeUndefined();
    expect(page.answer).not.toHaveBeenCalled();
  });

  it("keeps one dialog at a time and dismisses a second instead of replacing the first", () => {
    const popups = new BrowserPagePopups();
    const first = source();
    const second = source();
    const id = popups.offer({ kind: "dialog", dialog: "alert", message: "One" }, first);
    expect(
      popups.offer({ kind: "dialog", dialog: "alert", message: "Two" }, second),
    ).toBeUndefined();
    expect(second.dismiss).toHaveBeenCalledTimes(1);
    expect(popups.read()?.id).toBe(id);
  });

  it("dismisses a replaced menu and wakes a waiting presenter", async () => {
    const popups = new BrowserPagePopups();
    const waiting = popups.next(undefined, 1_000);
    const menu = source();
    popups.offer({ kind: "context", link: true, image: false }, menu);
    expect(await waiting).toMatchObject({ status: "popup", popup: { kind: "context" } });
    popups.offer(select, source());
    expect(menu.dismiss).toHaveBeenCalledTimes(1);
    expect(await popups.next(undefined, 10)).toMatchObject({ popup: { kind: "select" } });
  });

  it("refuses a second file for a single-file chooser", async () => {
    const popups = new BrowserPagePopups();
    const id = popups.offer({ kind: "file", multiple: false }, source());
    if (id === undefined) throw new Error("Expected an offered popup");
    expect(await popups.answer(id, { kind: "file", paths: ["/a", "/b"] })).toBe(false);
  });
});
