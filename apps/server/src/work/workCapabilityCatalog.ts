import {
  type WorkArtifactFormat,
  type WorkCapabilityReport,
} from "@octant/contracts/work-artifacts";
import { classifyWorkFidelity } from "@octant/domain";
import { getWorkFormatAdapter } from "./workFormatAdapter";

const readOnlyFlags = {
  canRead: true,
  canCreate: false,
  canMutate: false,
  canRoundTrip: false,
  canExport: false,
  canVersion: false,
} as const;

/**
 * Base, format-derived capability report for a Work format. The report is
 * derived from the registered format adapter: a format with an adapter reports
 * the adapter's honest capability flags and derived export formats; a format
 * without an adapter reports honest read-only capabilities, the mutation
 * authority denies create/mutate/export for that format, and the mutation
 * service returns an `unsupported` outcome. Fidelity is classified by the pure
 * domain policy so office formats report inherent limited fidelity and the
 * renderer presents the fidelity notice before any side effect.
 */
export function baseWorkCapabilityReport(format: WorkArtifactFormat): WorkCapabilityReport {
  const adapter = getWorkFormatAdapter(format);
  if (adapter !== undefined) {
    return {
      format,
      capabilities: adapter.capabilities,
      fidelity: classifyWorkFidelity(format, false),
      exportFormats: [...adapter.exportFormats],
    };
  }
  return {
    format,
    capabilities: readOnlyFlags,
    fidelity: classifyWorkFidelity(format, false),
    exportFormats: [],
  };
}
