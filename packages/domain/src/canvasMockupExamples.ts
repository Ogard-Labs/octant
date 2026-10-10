import { CANVAS_SCHEMA_VERSION, decodeCanvasBlock } from "@octant/contracts/canvas";
import type { CanvasMockupBlock } from "@octant/contracts/canvas";

/**
 * The screen an agent is shown when it asks how to draw one: a desktop
 * settings window as a wireframe, with a sidebar, tabs, a form, and numbered
 * callouts. Wire shape, not a branded block: describe returns this object
 * as-is.
 */
export const settingsScreenExample = {
  blockId: "settings-screen",
  schemaVersion: CANVAS_SCHEMA_VERSION,
  kind: "mockup" as const,
  device: "desktop" as const,
  fidelity: "wireframe" as const,
  title: "Settings",
  nodes: [
    { nodeId: "screen", component: "window" as const, label: "Settings" },
    { nodeId: "header", component: "header" as const, label: "Settings", parentId: "screen" },
    {
      nodeId: "find",
      component: "icon" as const,
      label: "Search settings",
      icon: "search" as const,
      parentId: "header",
    },
    { nodeId: "me", component: "avatar" as const, label: "Ada Lovelace", parentId: "header" },
    { nodeId: "sidebar", component: "sidebar" as const, label: "Sections", parentId: "screen" },
    { nodeId: "nav", component: "nav" as const, label: "Sections", parentId: "sidebar" },
    {
      nodeId: "profile-row",
      component: "list-row" as const,
      label: "Profile",
      icon: "user" as const,
      on: true,
      parentId: "nav",
    },
    {
      nodeId: "notifications",
      component: "list-row" as const,
      label: "Notifications",
      icon: "bell" as const,
      parentId: "nav",
    },
    {
      nodeId: "security-row",
      component: "list-row" as const,
      label: "Security",
      icon: "lock" as const,
      parentId: "nav",
    },
    { nodeId: "account", component: "tabs" as const, label: "Account", parentId: "screen" },
    { nodeId: "profile", component: "card" as const, label: "Profile", parentId: "account" },
    {
      nodeId: "blurb",
      component: "text" as const,
      label: "Shown to people in your workspace.",
      parentId: "profile",
    },
    {
      nodeId: "name",
      component: "form-field" as const,
      label: "Display name",
      value: "Ada Lovelace",
      parentId: "profile",
    },
    {
      nodeId: "email",
      component: "form-field" as const,
      label: "Email",
      value: "ada@example.com",
      parentId: "profile",
    },
    {
      nodeId: "language",
      component: "select" as const,
      label: "Language",
      value: "English",
      parentId: "profile",
    },
    {
      nodeId: "mail",
      component: "toggle" as const,
      label: "Email notifications",
      on: true,
      parentId: "profile",
    },
    {
      nodeId: "digest",
      component: "checkbox" as const,
      label: "Weekly digest",
      parentId: "profile",
    },
    { nodeId: "actions", component: "row" as const, label: "Actions", parentId: "profile" },
    { nodeId: "cancel", component: "button" as const, label: "Cancel", parentId: "actions" },
    {
      nodeId: "save",
      component: "button" as const,
      label: "Save",
      tone: "accent" as const,
      parentId: "actions",
    },
    { nodeId: "security", component: "card" as const, label: "Security", parentId: "account" },
    { nodeId: "lock", component: "text" as const, label: "Sign-in", parentId: "security" },
  ],
  annotations: [
    { nodeId: "nav", note: "The current section stays highlighted while the page scrolls." },
    { nodeId: "save", note: "Save stays disabled until a field changes." },
  ],
};

/**
 * One screen in three states side by side, drawn with the theme's tokens: a
 * phone notifications list when it has items, when it is empty, and when it
 * failed to load.
 */
export const notificationStatesExample = {
  blockId: "notification-states",
  schemaVersion: CANVAS_SCHEMA_VERSION,
  kind: "mockup" as const,
  device: "phone" as const,
  fidelity: "styled" as const,
  title: "Notifications",
  variants: [
    { variantId: "loaded", label: "Loaded" },
    { variantId: "empty", label: "Empty" },
    { variantId: "error", label: "Error" },
  ],
  nodes: [
    {
      nodeId: "loaded-page",
      component: "stack" as const,
      label: "Notifications",
      variantId: "loaded",
    },
    {
      nodeId: "loaded-title",
      component: "heading" as const,
      label: "Notifications",
      parentId: "loaded-page",
    },
    { nodeId: "inbox", component: "list" as const, label: "Recent", parentId: "loaded-page" },
    {
      nodeId: "mention",
      component: "list-row" as const,
      label: "Grace mentioned you",
      icon: "mail" as const,
      parentId: "inbox",
    },
    {
      nodeId: "invite",
      component: "list-row" as const,
      label: "You were added to Design",
      icon: "star" as const,
      parentId: "inbox",
    },
    {
      nodeId: "unread",
      component: "badge" as const,
      label: "2 new",
      tone: "accent" as const,
      parentId: "loaded-page",
    },
    {
      nodeId: "empty-page",
      component: "stack" as const,
      label: "Notifications",
      variantId: "empty",
    },
    {
      nodeId: "empty-title",
      component: "heading" as const,
      label: "Notifications",
      parentId: "empty-page",
    },
    {
      nodeId: "empty-art",
      component: "image-placeholder" as const,
      label: "Empty inbox illustration",
      parentId: "empty-page",
    },
    {
      nodeId: "empty-copy",
      component: "text" as const,
      label: "You're all caught up.",
      parentId: "empty-page",
    },
    {
      nodeId: "error-page",
      component: "stack" as const,
      label: "Notifications",
      variantId: "error",
    },
    {
      nodeId: "error-title",
      component: "heading" as const,
      label: "Notifications",
      parentId: "error-page",
    },
    {
      nodeId: "error-copy",
      component: "text" as const,
      label: "Notifications could not load.",
      parentId: "error-page",
    },
    {
      nodeId: "retry",
      component: "button" as const,
      label: "Try again",
      tone: "accent" as const,
      parentId: "error-page",
    },
    {
      nodeId: "offline",
      component: "toast" as const,
      label: "You're offline",
      tone: "danger" as const,
      parentId: "error-page",
    },
  ],
  annotations: [{ nodeId: "retry", note: "Retries once, then keeps the toast until online." }],
};

function mockupBlock(value: unknown): CanvasMockupBlock {
  const block = decodeCanvasBlock(value);
  if (block.kind !== "mockup") {
    throw new Error("Mockup example did not decode as a mockup block.");
  }
  return block;
}

export const settingsScreenExampleBlock = mockupBlock(settingsScreenExample);
export const notificationStatesExampleBlock = mockupBlock(notificationStatesExample);

/** Every mockup describe returns, in the order an agent reads them. */
export const mockupExamples = [settingsScreenExample, notificationStatesExample] as const;
