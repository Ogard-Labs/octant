import { CANVAS_SCHEMA_VERSION, decodeCanvasBlock } from "@octant/contracts/canvas";
import type { CanvasMockupBlock } from "@octant/contracts/canvas";

/**
 * The screen an agent is shown when it asks how to draw one.
 * Wire shape, not a branded block: describe returns this object as-is.
 */
export const settingsScreenExample = {
  blockId: "settings-screen",
  schemaVersion: CANVAS_SCHEMA_VERSION,
  kind: "mockup" as const,
  device: "desktop" as const,
  title: "Settings",
  nodes: [
    { nodeId: "screen", component: "window" as const, label: "Settings" },
    { nodeId: "header", component: "header" as const, label: "Settings", parentId: "screen" },
    {
      nodeId: "mark",
      component: "image-placeholder" as const,
      label: "Avatar",
      parentId: "header",
    },
    { nodeId: "sidebar", component: "sidebar" as const, label: "Sections", parentId: "screen" },
    { nodeId: "nav", component: "list" as const, label: "Sections", parentId: "sidebar" },
    { nodeId: "profile-row", component: "list-row" as const, label: "Profile", parentId: "nav" },
    {
      nodeId: "notifications",
      component: "list-row" as const,
      label: "Notifications",
      parentId: "nav",
    },
    { nodeId: "appearance", component: "list-row" as const, label: "Appearance", parentId: "nav" },
    { nodeId: "account", component: "tabs" as const, label: "Account", parentId: "screen" },
    { nodeId: "profile", component: "card" as const, label: "Profile", parentId: "account" },
    {
      nodeId: "blurb",
      component: "text" as const,
      label: "Shown on your profile.",
      parentId: "profile",
    },
    {
      nodeId: "name",
      component: "form-field" as const,
      label: "Display name",
      parentId: "profile",
    },
    { nodeId: "email", component: "form-field" as const, label: "Email", parentId: "profile" },
    {
      nodeId: "mail",
      component: "toggle" as const,
      label: "Email notifications",
      parentId: "profile",
      on: true,
    },
    { nodeId: "save", component: "button" as const, label: "Save", parentId: "profile" },
    { nodeId: "security", component: "card" as const, label: "Security", parentId: "account" },
    { nodeId: "lock", component: "text" as const, label: "Sign-in", parentId: "security" },
  ],
};

function mockupBlock(value: unknown): CanvasMockupBlock {
  const block = decodeCanvasBlock(value);
  if (block.kind !== "mockup") {
    throw new Error("Mockup example did not decode as a mockup block.");
  }
  return block;
}

export const settingsScreenExampleBlock = mockupBlock(settingsScreenExample);
