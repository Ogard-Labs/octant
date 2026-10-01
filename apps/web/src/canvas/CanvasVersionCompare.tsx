import type { CanvasDefinition } from "@octant/contracts/canvas";
import { canvasBlockLabel } from "./CanvasDocument";

type CanvasBlockEntry = CanvasDefinition["blocks"][number];

export interface CanvasBlockChange {
  readonly kind: "added" | "removed" | "changed";
  readonly blockId: string;
  readonly label: string;
}

/**
 * What changed between two versions, block by block. Blocks are matched by
 * id because a revision replaces the whole block list: position alone would
 * report every block after an insertion as changed.
 */
export function compareCanvasVersions(
  earlier: CanvasDefinition,
  later: CanvasDefinition,
): ReadonlyArray<CanvasBlockChange> {
  const before = new Map(earlier.blocks.map((block) => [String(block.blockId), block]));
  const after = new Set(later.blocks.map((block) => String(block.blockId)));
  const changes: CanvasBlockChange[] = [];
  for (const block of later.blocks) {
    const blockId = String(block.blockId);
    const previous = before.get(blockId);
    if (previous === undefined) {
      changes.push({ kind: "added", blockId, label: canvasBlockLabel(block) });
    } else if (!sameBlock(previous, block)) {
      changes.push({ kind: "changed", blockId, label: canvasBlockLabel(block) });
    }
  }
  for (const block of earlier.blocks) {
    if (!after.has(String(block.blockId))) {
      changes.push({
        kind: "removed",
        blockId: String(block.blockId),
        label: canvasBlockLabel(block),
      });
    }
  }
  return changes;
}

function sameBlock(left: CanvasBlockEntry, right: CanvasBlockEntry): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

const CHANGE_LABELS = { added: "Added", removed: "Removed", changed: "Changed" } as const;

export function CanvasVersionCompare(props: {
  readonly earlier: { readonly sequence: number; readonly definition: CanvasDefinition };
  readonly later: { readonly sequence: number; readonly definition: CanvasDefinition };
}) {
  const changes = compareCanvasVersions(props.earlier.definition, props.later.definition);
  const retitled = props.earlier.definition.title !== props.later.definition.title;
  return (
    <section
      aria-label={`Changes from v${String(props.earlier.sequence)} to v${String(props.later.sequence)}`}
      className="canvas-compare"
    >
      {retitled ? (
        <p className="canvas-compare__note">
          Title changed from “{props.earlier.definition.title}”.
        </p>
      ) : null}
      {changes.length === 0 ? (
        <p className="canvas-compare__note">No blocks changed.</p>
      ) : (
        <ul className="canvas-compare__list">
          {changes.map((change) => (
            <li
              className="canvas-compare__change"
              data-change={change.kind}
              key={`${change.kind}:${change.blockId}`}
            >
              <span className="canvas-compare__kind">{CHANGE_LABELS[change.kind]}</span>
              <span>{change.label}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
