import { CURSOR_ACP_NO_GO_RESIDUAL_ID } from "./cursorAcpPolicy";

export interface CursorAcpSettingsViewModel {
  readonly providerLabel: "Cursor ACP";
  readonly selectable: false;
  readonly createEnabled: false;
  readonly editEnabled: false;
  readonly probeEnabled: true;
  readonly residualPacketId: typeof CURSOR_ACP_NO_GO_RESIDUAL_ID;
  readonly helperText: string;
}

/**
 * Provider Settings may surface Cursor ACP only as a blocked residual entry.
 * Probe is allowed for future compatibility re-checks; create/edit/enable and
 * production selection remain denied while the compatibility probe is NO-GO.
 */
export function buildCursorAcpSettingsViewModel(): CursorAcpSettingsViewModel {
  return {
    providerLabel: "Cursor ACP",
    selectable: false,
    createEnabled: false,
    editEnabled: false,
    probeEnabled: true,
    residualPacketId: CURSOR_ACP_NO_GO_RESIDUAL_ID,
    helperText:
      "Cursor ACP remains NO-GO residual only. Probe is allowed; production configuration and selection stay disabled until a future compatibility probe returns GO.",
  };
}

export function assertCursorAcpSettingsMutationAllowed(input: {
  readonly action: "create" | "edit" | "enable" | "select" | "probe";
}): { readonly allowed: true } | { readonly allowed: false; readonly reason: string } {
  if (input.action === "probe") return { allowed: true };
  return {
    allowed: false,
    reason: `Cursor ACP ${input.action} is blocked by residual ${CURSOR_ACP_NO_GO_RESIDUAL_ID}.`,
  };
}
