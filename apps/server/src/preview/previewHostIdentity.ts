import { Schema } from "effect";
import { PreviewHostId } from "@octant/contracts/previews";
import { deriveHostRuntimeHostId } from "@octant/host-runtime";

const decodeHostId = Schema.decodeUnknownSync(PreviewHostId);

/**
 * Derive a stable `PreviewHostId` from a per-install seed (the resolved
 * Octant data directory). The id is deterministic across server restarts
 * so preview targets minted with it remain valid after reconnect, and two
 * hosts with different data directories never share a host id.
 */
export function derivePreviewHostId(seed: string): typeof PreviewHostId.Type {
  return decodeHostId(deriveHostRuntimeHostId(seed));
}
