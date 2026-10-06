import type { ReactNode } from "react";
import type {
  CanvasErBlock,
  CanvasMindmapBlock,
  CanvasSequenceBlock,
  CanvasStateBlock,
  CanvasSwimlaneBlock,
} from "@octant/contracts/canvas";
import {
  layoutCanvasEr,
  layoutCanvasMindmap,
  layoutCanvasSequence,
  layoutCanvasState,
  layoutCanvasSwimlane,
  type CanvasDiagramPoint,
} from "@octant/domain";

/**
 * Sequence and state diagrams, drawn from the same layout every surface uses.
 *
 * Colour comes from the diagram tokens, so Default stays monochrome and light
 * and dark follow the theme. Participants, states, messages, and transitions
 * carry the identifiers a comment anchors to.
 */

function fitLabel(label: string, width: number): string {
  const max = Math.max(4, Math.floor((width - 16) / 7));
  return label.length <= max ? label : `${label.slice(0, Math.max(1, max - 1))}…`;
}

function arrowPoints(points: ReadonlyArray<CanvasDiagramPoint>): string | undefined {
  const end = points[points.length - 1];
  const before = points[points.length - 2];
  if (end === undefined || before === undefined) return undefined;
  const dx = end.x - before.x;
  const dy = end.y - before.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return undefined;
  const ux = dx / length;
  const uy = dy / length;
  const size = 7;
  const half = 3.5;
  const baseX = end.x - ux * size;
  const baseY = end.y - uy * size;
  return `${end.x},${end.y} ${baseX - uy * half},${baseY + ux * half} ${baseX + uy * half},${baseY - ux * half}`;
}

function route(points: ReadonlyArray<CanvasDiagramPoint>): string {
  return points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x} ${point.y}`).join(" ");
}

export function SequenceDiagram({ block }: { readonly block: CanvasSequenceBlock }) {
  const layout = layoutCanvasSequence(block);
  return (
    <figure
      aria-label={sequenceLabel(block)}
      className="canvas-block__diagram canvas-block__kind-diagram"
    >
      <svg
        className="canvas-block__diagram-svg"
        height={layout.height}
        role="presentation"
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        width={layout.width}
      >
        {layout.participants.map((participant) => (
          <line
            className="canvas-block__sequence-lifeline"
            key={`${participant.participantId}-lifeline`}
            x1={participant.lifelineX}
            x2={participant.lifelineX}
            y1={participant.lifelineY1}
            y2={participant.lifelineY2}
          />
        ))}
        {layout.activations.map((activation) => (
          <rect
            className="canvas-block__sequence-activation"
            height={activation.height}
            key={activation.activationId}
            width={activation.width}
            x={activation.x}
            y={activation.y}
          />
        ))}
        {layout.messages.map((message) => {
          const head = arrowPoints(message.points);
          return (
            <g data-edge-id={message.messageId} key={message.messageId}>
              <path className="canvas-block__diagram-edge" d={route(message.points)} fill="none" />
              {head === undefined ? null : (
                <polygon className="canvas-block__diagram-arrow" points={head} />
              )}
              <text
                className="canvas-block__diagram-edge-label"
                x={message.labelX}
                y={message.labelY}
              >
                <title>{message.label}</title>
                {fitLabel(message.label, 200)}
              </text>
            </g>
          );
        })}
        {layout.notes.map((note) => (
          <g className="canvas-block__diagram-group" key={note.noteId}>
            <rect height={note.height} rx={6} width={note.width} x={note.x} y={note.y} />
            <text x={note.x + 8} y={note.y + 20}>
              <title>{note.text}</title>
              {fitLabel(note.text, note.width)}
            </text>
          </g>
        ))}
        {layout.participants.map((participant) => (
          <g
            aria-label={participant.label}
            className="canvas-block__diagram-node"
            data-node-id={participant.participantId}
            key={participant.participantId}
          >
            <rect
              height={participant.height}
              rx={6}
              width={participant.width}
              x={participant.x}
              y={participant.y}
            />
            <text
              x={participant.x + participant.width / 2}
              y={participant.y + participant.height / 2}
            >
              {fitLabel(participant.label, participant.width)}
            </text>
          </g>
        ))}
      </svg>
      <figcaption className="canvas-block__diagram-fallback visually-hidden">
        <ul>
          {block.messages.map((message) => (
            <li key={message.messageId}>{`${message.from} ${message.label} ${message.to}`}</li>
          ))}
          {(block.notes ?? []).map((note) => (
            <li key={note.noteId}>{note.text}</li>
          ))}
        </ul>
      </figcaption>
    </figure>
  );
}

export function StateDiagram({ block }: { readonly block: CanvasStateBlock }) {
  const layout = layoutCanvasState(block);
  const containers = layout.states.filter((state) => state.nested);
  const markers = layout.states.filter((state) => !state.nested);
  return (
    <figure
      aria-label={stateLabel(block)}
      className="canvas-block__diagram canvas-block__kind-diagram"
    >
      <svg
        className="canvas-block__diagram-svg"
        height={layout.height}
        role="presentation"
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        width={layout.width}
      >
        {layout.transitions.map((transition) => {
          const head = arrowPoints(transition.points);
          return (
            <g data-edge-id={transition.transitionId} key={transition.transitionId}>
              <path
                className="canvas-block__diagram-edge"
                d={route(transition.points)}
                fill="none"
              />
              {head === undefined ? null : (
                <polygon className="canvas-block__diagram-arrow" points={head} />
              )}
              <text
                className="canvas-block__diagram-edge-label"
                x={transition.labelX}
                y={transition.labelY}
              >
                {transition.label}
              </text>
            </g>
          );
        })}
        {containers.map((state) => (
          <g
            aria-label={state.label}
            className="canvas-block__diagram-group"
            data-node-id={state.stateId}
            key={state.stateId}
          >
            <rect height={state.height} rx={8} width={state.width} x={state.x} y={state.y} />
            <text className="canvas-block__state-header" x={state.x + 10} y={state.y + 16}>
              {state.label}
            </text>
          </g>
        ))}
        {markers.map((state) =>
          state.role === "initial" || state.role === "final" ? (
            <g aria-label={state.label} data-node-id={state.stateId} key={state.stateId}>
              <circle
                className={
                  state.role === "initial"
                    ? "canvas-block__state-initial"
                    : "canvas-block__state-final"
                }
                cx={state.x + state.width / 2}
                cy={state.y + state.height / 2}
                r={state.width / 2}
              />
              {state.role === "final" ? (
                <circle
                  className="canvas-block__state-final"
                  cx={state.x + state.width / 2}
                  cy={state.y + state.height / 2}
                  r={Math.max(2, state.width / 2 - 3)}
                />
              ) : null}
              <text
                className="canvas-block__state-header"
                textAnchor="middle"
                x={state.x + state.width / 2}
                y={state.y + state.height + 14}
              >
                {state.label}
              </text>
            </g>
          ) : (
            <g
              aria-label={state.label}
              className="canvas-block__diagram-node"
              data-node-id={state.stateId}
              key={state.stateId}
            >
              <rect height={state.height} rx={6} width={state.width} x={state.x} y={state.y} />
              <text x={state.x + state.width / 2} y={state.y + state.height / 2}>
                {fitLabel(state.label, state.width)}
              </text>
            </g>
          ),
        )}
      </svg>
      <figcaption className="canvas-block__diagram-fallback visually-hidden">
        <ul>
          {block.transitions.map((transition) => (
            <li key={transition.transitionId}>
              {`${transition.source} ${transition.label} ${transition.target}`}
            </li>
          ))}
        </ul>
      </figcaption>
    </figure>
  );
}

function sequenceLabel(block: CanvasSequenceBlock): string {
  return `Sequence with ${String(block.participants.length)} participants and ${String(block.messages.length)} messages`;
}

function stateLabel(block: CanvasStateBlock): string {
  return `State machine with ${String(block.states.length)} states and ${String(block.transitions.length)} transitions`;
}

export function ErDiagram({ block }: { readonly block: CanvasErBlock }) {
  const layout = layoutCanvasEr(block);
  return (
    <figure
      aria-label={erLabel(block)}
      className="canvas-block__diagram canvas-block__kind-diagram"
      tabIndex={0}
    >
      <svg
        className="canvas-block__diagram-svg"
        height={layout.height}
        role="presentation"
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        width={layout.width}
      >
        {layout.relationships.map((relationship) => {
          const start = relationship.points[0];
          const end = relationship.points[1];
          return (
            <g data-edge-id={relationship.relationshipId} key={relationship.relationshipId}>
              <path
                className="canvas-block__diagram-edge"
                d={route(relationship.points)}
                fill="none"
              />
              {relationship.label === undefined ? null : (
                <text
                  className="canvas-block__diagram-edge-label"
                  x={relationship.labelX}
                  y={relationship.labelY}
                >
                  {relationship.label}
                </text>
              )}
              {start === undefined || end === undefined ? null : (
                <>
                  <text
                    className="canvas-block__er-cardinality"
                    x={start.x + (end.x - start.x) * 0.2}
                    y={start.y + (end.y - start.y) * 0.2 - 4}
                  >
                    {relationship.sourceCardinality}
                  </text>
                  <text
                    className="canvas-block__er-cardinality"
                    x={start.x + (end.x - start.x) * 0.8}
                    y={start.y + (end.y - start.y) * 0.8 - 4}
                  >
                    {relationship.targetCardinality}
                  </text>
                </>
              )}
            </g>
          );
        })}
        {layout.entities.map((entity) => (
          <g
            aria-label={entity.label}
            className="canvas-block__diagram-node"
            data-node-id={entity.entityId}
            key={entity.entityId}
          >
            <rect
              className="canvas-block__er-frame"
              height={entity.height}
              rx={6}
              width={entity.width}
              x={entity.x}
              y={entity.y}
            />
            <rect
              className="canvas-block__er-header"
              height={entity.headerHeight}
              rx={6}
              width={entity.width}
              x={entity.x}
              y={entity.y}
            />
            <text className="canvas-block__er-entity-label" x={entity.x + 10} y={entity.y + 18}>
              <title>{entity.label}</title>
              {fitLabel(entity.label, entity.width)}
            </text>
            {entity.attributes.map((attribute) => (
              <text
                className="canvas-block__er-attribute"
                key={attribute.attributeId}
                x={attribute.x + 4}
                y={attribute.y + 14}
              >
                <title>
                  {`${attribute.name}: ${attribute.type}${attribute.key ? " (key)" : ""}`}
                </title>
                {fitLabel(
                  `${attribute.name}: ${attribute.type}${attribute.key ? " (key)" : ""}`,
                  entity.width,
                )}
              </text>
            ))}
          </g>
        ))}
      </svg>
      <figcaption className="canvas-block__diagram-fallback visually-hidden">
        <table>
          <caption>{erLabel(block)}</caption>
          <thead>
            <tr>
              <th scope="col">Entity</th>
              <th scope="col">Attribute</th>
              <th scope="col">Type</th>
              <th scope="col">Key</th>
            </tr>
          </thead>
          <tbody>
            {block.entities.flatMap((entity) =>
              entity.attributes.length === 0
                ? [
                    <tr key={entity.entityId}>
                      <th scope="row">{entity.label}</th>
                      <td />
                      <td />
                      <td />
                    </tr>,
                  ]
                : entity.attributes.map((attribute) => (
                    <tr key={attribute.attributeId}>
                      <th scope="row">{entity.label}</th>
                      <td>{attribute.name}</td>
                      <td>{attribute.type}</td>
                      <td>{attribute.key === true ? "key" : ""}</td>
                    </tr>
                  )),
            )}
          </tbody>
        </table>
      </figcaption>
    </figure>
  );
}

export function SwimlaneDiagram({ block }: { readonly block: CanvasSwimlaneBlock }) {
  const layout = layoutCanvasSwimlane(block);
  const stepLabels = new Map(block.steps.map((step) => [String(step.stepId), step.label]));
  return (
    <figure
      aria-label={swimlaneLabel(block)}
      className="canvas-block__diagram canvas-block__kind-diagram"
      tabIndex={0}
    >
      <svg
        className="canvas-block__diagram-svg"
        height={layout.height}
        role="presentation"
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        width={layout.width}
      >
        {layout.connections.map((connection) => (
          <g data-edge-id={connection.connectionId} key={connection.connectionId}>
            <path className="canvas-block__diagram-edge" d={route(connection.points)} fill="none" />
            {connection.label === undefined ? null : (
              <text
                className="canvas-block__diagram-edge-label"
                x={connection.labelX}
                y={connection.labelY}
              >
                {connection.label}
              </text>
            )}
          </g>
        ))}
        {layout.lanes.map((lane) => (
          <g
            aria-label={lane.label}
            className="canvas-block__diagram-node"
            data-node-id={lane.laneId}
            key={lane.laneId}
          >
            <rect
              className="canvas-block__swimlane-band"
              height={lane.height}
              width={lane.width}
              x={lane.x}
              y={lane.y}
            />
            <line
              className="canvas-block__swimlane-divider"
              x1={lane.x + 132}
              x2={lane.x + 132}
              y1={lane.y}
              y2={lane.y + lane.height}
            />
            <text className="canvas-block__swimlane-label" x={lane.x + 10} y={lane.y + 18}>
              <title>{lane.label}</title>
              {fitLabel(lane.label, 120)}
            </text>
            <text className="canvas-block__swimlane-kind" x={lane.x + 10} y={lane.y + 32}>
              {lane.kind}
            </text>
          </g>
        ))}
        {layout.steps.map((step) => (
          <g
            aria-label={step.label}
            className="canvas-block__diagram-node"
            data-node-id={step.stepId}
            key={step.stepId}
          >
            <rect
              className={
                step.decision
                  ? "canvas-block__swimlane-step canvas-block__swimlane-step--decision"
                  : "canvas-block__swimlane-step"
              }
              height={step.height}
              rx={6}
              width={step.width}
              x={step.x}
              y={step.y}
            />
            <text x={step.x + step.width / 2} y={step.y + step.height / 2}>
              <title>{step.label}</title>
              {fitLabel(step.label, step.width)}
            </text>
          </g>
        ))}
      </svg>
      <figcaption className="canvas-block__diagram-fallback visually-hidden">
        {block.lanes.map((lane) => (
          <div key={lane.laneId}>
            <h3>{lane.label}</h3>
            <ol>
              {block.steps
                .filter((step) => String(step.laneId) === String(lane.laneId))
                .map((step) => (
                  <li key={step.stepId}>{step.label}</li>
                ))}
            </ol>
          </div>
        ))}
        <ul>
          {block.connections.map((connection) => (
            <li key={connection.connectionId}>
              {`${stepLabels.get(String(connection.source)) ?? connection.source} → ${
                stepLabels.get(String(connection.target)) ?? connection.target
              }${connection.label === undefined ? "" : `: ${connection.label}`}`}
            </li>
          ))}
        </ul>
      </figcaption>
    </figure>
  );
}

export function MindmapDiagram({ block }: { readonly block: CanvasMindmapBlock }) {
  const layout = layoutCanvasMindmap(block);
  const childrenOf = new Map<string, string[]>();
  let rootId: string | undefined;
  for (const node of block.nodes) {
    const id = String(node.nodeId);
    if (node.parentId === undefined) {
      rootId ??= id;
      continue;
    }
    const siblings = childrenOf.get(String(node.parentId)) ?? [];
    siblings.push(id);
    childrenOf.set(String(node.parentId), siblings);
  }
  const byId = new Map(block.nodes.map((node) => [String(node.nodeId), node]));
  const fallback = (id: string, key: string): ReactNode => {
    const node = byId.get(id);
    const children = childrenOf.get(id) ?? [];
    return (
      <li key={key}>
        {node?.note === undefined ? (node?.label ?? id) : `${node.label} — ${node.note}`}
        {children.length === 0 ? null : (
          <ul>{children.map((child) => fallback(child, `${key}/${child}`))}</ul>
        )}
      </li>
    );
  };
  return (
    <figure
      aria-label={mindmapLabel(block)}
      className="canvas-block__diagram canvas-block__kind-diagram"
      tabIndex={0}
    >
      <svg
        className="canvas-block__diagram-svg"
        height={layout.height}
        role="presentation"
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        width={layout.width}
      >
        {layout.edges.map((edge) => (
          <path
            className="canvas-block__diagram-edge"
            d={route(edge.points)}
            fill="none"
            key={`${edge.parentId}/${edge.childId}`}
          />
        ))}
        {layout.nodes.map((node) => (
          <g
            aria-label={node.label}
            className="canvas-block__diagram-node"
            data-node-id={node.nodeId}
            key={node.nodeId}
          >
            <rect
              className={
                node.root
                  ? "canvas-block__mindmap-node canvas-block__mindmap-node--root"
                  : "canvas-block__mindmap-node"
              }
              height={node.height}
              rx={node.root ? 10 : 6}
              width={node.width}
              x={node.x}
              y={node.y}
            />
            <text
              x={node.x + node.width / 2}
              y={node.y + (node.note === undefined ? node.height / 2 : 14)}
            >
              <title>{node.label}</title>
              {fitLabel(node.label, node.width)}
            </text>
            {node.note === undefined ? null : (
              <text
                className="canvas-block__mindmap-note"
                x={node.x + node.width / 2}
                y={node.y + node.height - 6}
              >
                <title>{node.note}</title>
                {fitLabel(node.note, node.width)}
              </text>
            )}
          </g>
        ))}
      </svg>
      <figcaption className="canvas-block__diagram-fallback visually-hidden">
        <ul>{rootId === undefined ? null : fallback(rootId, rootId)}</ul>
      </figcaption>
    </figure>
  );
}

function erLabel(block: CanvasErBlock): string {
  return `Entity relationship with ${String(block.entities.length)} entities and ${String(block.relationships.length)} relationships`;
}

function swimlaneLabel(block: CanvasSwimlaneBlock): string {
  return `Swimlane with ${String(block.lanes.length)} lanes and ${String(block.steps.length)} steps`;
}

function mindmapLabel(block: CanvasMindmapBlock): string {
  return `Mind map with ${String(block.nodes.length)} topics`;
}
