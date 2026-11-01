import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DESKTOP_IPC_CHANNELS as IPC_CHANNELS } from "./ipcChannels";

describe("the extension bridge preload", () => {
  it("uses the same channel names as the app side", () => {
    const source = readFileSync(new URL("./extensionBridgePreload.ts", import.meta.url), "utf8");
    expect(source).toContain(`const TABS_CHANNEL = "${IPC_CHANNELS.browserExtensionTabs}"`);
    expect(source).toContain(
      `const ACTION_CHANNEL = "${IPC_CHANNELS.browserExtensionActionClicked}"`,
    );
  });
});
