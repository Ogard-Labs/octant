import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DEFAULT_THEME_SETTINGS } from "@octant/contracts/theme";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { createThemeRouteHandler } from "./themeRoutes";

describe("theme routes", () => {
  it("requires authenticated loopback access and exposes bootstrap/commands", async () => {
    const authorities = new WindowAuthorityStore();
    const capability = randomBytes(32).toString("base64url");
    const windowId = "00000000-0000-4000-8000-000000000401" as never;
    authorities.register({ windowId, capability, now: 1_000 });
    const service = {
      bootstrap: () => ({ settings: DEFAULT_THEME_SETTINGS, version: 0 as never }),
      execute: () => ({
        kind: "theme-settings-replaced" as const,
        settings: DEFAULT_THEME_SETTINGS,
        version: 1 as never,
      }),
    };
    const handle = createThemeRouteHandler({
      service,
      windowAuthorityStore: authorities,
      now: () => 1_001,
    });
    expect((await handle(new Request("http://127.0.0.1/api/theme/bootstrap")))?.status).toBe(401);
    const response = await handle(
      new Request("http://127.0.0.1/api/theme/bootstrap", {
        headers: { "x-octant-window-capability": capability },
      }),
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ version: 0, settings: { mode: "system" } });
  });
});
