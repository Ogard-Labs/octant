import { describe, expect, it } from "vitest";
import { CANVAS_SCHEMA_VERSION, decodeCanvasBlock } from "@octant/contracts/canvas";
import { canvasMockupsTsx } from "./canvasMockupTsx";

const base = { schemaVersion: CANVAS_SCHEMA_VERSION };

const settings = decodeCanvasBlock({
  ...base,
  blockId: "settings",
  kind: "mockup",
  device: "phone",
  title: "Settings",
  variants: [
    { variantId: "off", label: "Off" },
    { variantId: "on", label: "On" },
  ],
  nodes: [
    { nodeId: "w-off", component: "window", label: "Settings", variantId: "off" },
    { nodeId: "sync-off", parentId: "w-off", component: "toggle", label: "Sync" },
    { nodeId: "w-on", component: "window", label: "Settings", variantId: "on" },
    { nodeId: "sync-on", parentId: "w-on", component: "toggle", label: "Sync {fast}", on: true },
    { nodeId: "volume", parentId: "w-on", component: "slider", label: "Volume", progress: 40 },
  ],
});
const sameTitle = decodeCanvasBlock({
  ...base,
  blockId: "settings-again",
  kind: "mockup",
  device: "phone",
  title: "Settings",
  nodes: [{ nodeId: "w", component: "window", label: "Settings" }],
});

describe("mockup TSX handoff", () => {
  it("writes one component per variant, each name unique across the file", () => {
    const tsx = canvasMockupsTsx([settings, sameTitle]) ?? "";
    expect(tsx).toContain("export function SettingsOff() {");
    expect(tsx).toContain("export function SettingsOn() {");
    expect(tsx).toContain("export function Settings() {");
    const names = [...tsx.matchAll(/export function (\w+)\(/g)].map((match) => match[1]);
    expect(new Set(names).size).toBe(names.length);
  });

  it("writes JSX rather than HTML: className, closed inputs, default states, escaped braces", () => {
    const tsx = canvasMockupsTsx([settings]) ?? "";
    expect(tsx).not.toMatch(/\sclass="/);
    expect(tsx).toContain('className="oct-mockup-page"');
    expect(tsx).toMatch(/<input [^>]*defaultChecked[^>]*\/>/);
    expect(tsx).toMatch(/<input [^>]*defaultValue="40"[^>]*\/>/);
    expect(tsx).not.toMatch(/<input [^>]*[^/]>/);
    expect(tsx).toContain("Sync &#123;fast&#125;");
    // The stylesheet is rendered, not merely declared.
    expect(tsx).toContain("<style>{mockupStyles}</style>");
    expect(tsx).not.toMatch(/^import /m);
    expect(tsx.toLowerCase()).not.toContain("<script");
  });

  it("hands off nothing for a Canvas without a mockup, and the same bytes every time", () => {
    expect(canvasMockupsTsx([])).toBeUndefined();
    expect(canvasMockupsTsx([settings])).toBe(canvasMockupsTsx([settings]));
  });
});
