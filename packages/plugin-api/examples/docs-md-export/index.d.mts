import type { CanvasExportTarget, CanvasExportTextFormat } from "../../src/canvasExport";

export interface PageHostExportConfiguration {
  readonly apiBase?: string;
  readonly fetch?: (request: Request) => Promise<Response>;
  readonly credentialRef?: string;
  readonly targetId?: string;
  readonly label?: string;
  readonly formats?: ReadonlyArray<CanvasExportTextFormat>;
  readonly note?: string;
}

export const DEFAULT_API_BASE: string;
export function createPageHostExportTarget(config: PageHostExportConfiguration): CanvasExportTarget;
export const canvasExport: CanvasExportTarget;
