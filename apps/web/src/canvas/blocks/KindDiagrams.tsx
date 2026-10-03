import type { CanvasSequenceBlock, CanvasStateBlock } from "@octant/contracts/canvas";
import { layoutCanvasSequence, layoutCanvasState, type CanvasDiagramPoint } from "@octant/domain";

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
