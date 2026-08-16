import { describe, expect, it } from "vitest";
import {
  assertCursorAcpSettingsMutationAllowed,
  buildCursorAcpSettingsViewModel,
} from "./cursorAcpSettingsPolicy";
import { CURSOR_ACP_NO_GO_RESIDUAL_ID } from "./cursorAcpPolicy";

describe("Cursor ACP settings policy", () => {
  it("exposes a non-selectable settings surface with probe-only enablement", () => {
    const model = buildCursorAcpSettingsViewModel();
    expect(model.selectable).toBe(false);
    expect(model.createEnabled).toBe(false);
    expect(model.editEnabled).toBe(false);
    expect(model.probeEnabled).toBe(true);
    expect(model.residualPacketId).toBe(CURSOR_ACP_NO_GO_RESIDUAL_ID);
  });

  it("allows probe and denies create/edit/enable/select mutations", () => {
    expect(assertCursorAcpSettingsMutationAllowed({ action: "probe" })).toEqual({ allowed: true });
    expect(assertCursorAcpSettingsMutationAllowed({ action: "create" }).allowed).toBe(false);
    expect(assertCursorAcpSettingsMutationAllowed({ action: "enable" }).allowed).toBe(false);
    expect(assertCursorAcpSettingsMutationAllowed({ action: "edit" }).allowed).toBe(false);
    const select = assertCursorAcpSettingsMutationAllowed({ action: "select" });
    expect(select.allowed).toBe(false);
    if (!select.allowed) {
      expect(select.reason).toContain(CURSOR_ACP_NO_GO_RESIDUAL_ID);
    }
  });
});
