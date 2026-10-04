import type {
  CanvasSequenceBlock,
  CanvasStateBlock,
  CanvasStateRole,
} from "@octant/contracts/canvas";

/**
 * Where a sequence or state diagram's parts sit, worked out from the block alone.
 *
 * The same reading the generic board uses: every surface draws the same picture
 * from the same data, and nothing here decides what the diagram means.
 */

export interface CanvasDiagramPoint {
  readonly x: number;
  readonly y: number;
}

export interface CanvasSequenceLayout {
  readonly width: number;
  readonly height: number;
  readonly participants: ReadonlyArray<CanvasSequenceParticipantBox>;
  readonly messages: ReadonlyArray<CanvasSequenceMessageRoute>;
  readonly activations: ReadonlyArray<CanvasSequenceActivationBox>;
  readonly notes: ReadonlyArray<CanvasSequenceNoteBox>;
}

export interface CanvasSequenceParticipantBox {
  readonly participantId: string;
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly lifelineX: number;
  readonly lifelineY1: number;
  readonly lifelineY2: number;
}

export interface CanvasSequenceMessageRoute {
  readonly messageId: string;
  readonly label: string;
  readonly self: boolean;
  readonly points: ReadonlyArray<CanvasDiagramPoint>;
  readonly labelX: number;
  readonly labelY: number;
}

export interface CanvasSequenceActivationBox {
  readonly activationId: string;
  readonly participantId: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface CanvasSequenceNoteBox {
  readonly noteId: string;
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface CanvasStateLayout {
  readonly width: number;
  readonly height: number;
  readonly states: ReadonlyArray<CanvasStateBox>;
  readonly transitions: ReadonlyArray<CanvasStateTransitionRoute>;
}

export interface CanvasStateBox {
  readonly stateId: string;
  readonly label: string;
  readonly role: "state" | CanvasStateRole;
  readonly nested: boolean;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface CanvasStateTransitionRoute {
  readonly transitionId: string;
  readonly label: string;
  readonly self: boolean;
  readonly points: ReadonlyArray<CanvasDiagramPoint>;
  readonly labelX: number;
  readonly labelY: number;
}

const MARGIN = 24;
const PARTICIPANT_WIDTH = 128;
const PARTICIPANT_HEIGHT = 36;
const PARTICIPANT_GAP = 48;
const MESSAGE_STEP = 40;
const LIFELINE_PAD = 20;
const NOTE_WIDTH = 240;
const NOTE_HEIGHT = 32;
const NOTE_GAP = 8;
const ACTIVATION_WIDTH = 10;
const ACTIVATION_PAD = 8;
const SELF_BEND = 28;
const SELF_DROP = 16;
const LABEL_LIFT = 8;

const STATE_WIDTH = 140;
const STATE_HEIGHT = 44;
const MARKER = 18;
const REGION_PAD = 16;
const REGION_HEADER = 24;
const SIBLING_GAP = 24;
const RANK_GAP = 56;
const SELF_LOOP = 24;

export function layoutCanvasSequence(block: CanvasSequenceBlock): CanvasSequenceLayout {
  const participants = block.participants.map((participant, index) => {
    const x = MARGIN + index * (PARTICIPANT_WIDTH + PARTICIPANT_GAP);
    return {
      participantId: String(participant.participantId),
      label: participant.label,
      x,
      y: MARGIN,
      width: PARTICIPANT_WIDTH,
      height: PARTICIPANT_HEIGHT,
      lifelineX: x + PARTICIPANT_WIDTH / 2,
    };
  });
  const byParticipant = new Map(
    participants.map((participant) => [participant.participantId, participant]),
  );
  const messageY = (index: number) =>
    MARGIN + PARTICIPANT_HEIGHT + LIFELINE_PAD + index * MESSAGE_STEP;
  const messages = block.messages.flatMap((message, index) => {
    const from = byParticipant.get(String(message.from));
    const to = byParticipant.get(String(message.to));
    if (from === undefined || to === undefined) return [];
    const y = messageY(index);
    const self = from.participantId === to.participantId;
    const points = self
      ? [
          { x: from.lifelineX, y },
          { x: from.lifelineX + SELF_BEND, y },
          { x: from.lifelineX + SELF_BEND, y: y + SELF_DROP },
          { x: from.lifelineX, y: y + SELF_DROP },
        ]
      : [
          { x: from.lifelineX, y },
          { x: to.lifelineX, y },
        ];
    const labelPoint = points[1] ?? points[0];
    return [
      {
        messageId: String(message.messageId),
        label: message.label,
        self,
        points,
        labelX: self ? (labelPoint?.x ?? from.lifelineX) : (from.lifelineX + to.lifelineX) / 2,
        labelY: y - LABEL_LIFT,
      },
    ];
  });
  const messageIndex = new Map(
    block.messages.map((message, index) => [String(message.messageId), index]),
  );
  const lastMessageY =
    messages.length === 0
      ? MARGIN + PARTICIPANT_HEIGHT
      : messageY(block.messages.length - 1) + SELF_DROP;
  const lifelineY1 = MARGIN + PARTICIPANT_HEIGHT;
  const lifelineY2 = lastMessageY + LIFELINE_PAD;
  const placedParticipants = participants.map((participant) => ({
    ...participant,
    lifelineY1,
    lifelineY2,
  }));

  const activations = (block.activations ?? []).flatMap((activation) => {
    const participant = byParticipant.get(String(activation.participantId));
    const start = messageIndex.get(String(activation.startMessageId));
    const end = messageIndex.get(String(activation.endMessageId));
    if (participant === undefined || start === undefined || end === undefined || start > end)
      return [];
    const y = messageY(start) - ACTIVATION_PAD;
    const bottom = messageY(end) + (start === end ? SELF_DROP : 0) + ACTIVATION_PAD;
    return [
      {
        activationId: String(activation.activationId),
        participantId: participant.participantId,
        x: participant.lifelineX - ACTIVATION_WIDTH / 2,
        y,
        width: ACTIVATION_WIDTH,
        height: Math.max(ACTIVATION_WIDTH, bottom - y),
      },
    ];
  });

  const noteColumn =
    participants.length === 0
      ? MARGIN
      : MARGIN +
        participants.length * PARTICIPANT_WIDTH +
        (participants.length - 1) * PARTICIPANT_GAP +
        PARTICIPANT_GAP;
  const notes = (block.notes ?? []).map((note, index) => {
    const after =
      note.afterMessageId === undefined ? undefined : messageIndex.get(String(note.afterMessageId));
    const y =
      after === undefined
        ? MARGIN + index * (NOTE_HEIGHT + NOTE_GAP)
        : messageY(after) - NOTE_HEIGHT / 2;
    return {
      noteId: String(note.noteId),
      text: note.text,
      x: noteColumn,
      y,
      width: NOTE_WIDTH,
      height: NOTE_HEIGHT,
    };
  });

  const rights = [
    ...placedParticipants.map((participant) => participant.x + participant.width),
    ...notes.map((note) => note.x + note.width),
    ...messages.flatMap((message) => message.points.map((point) => point.x)),
  ];
  const bottoms = [
    ...placedParticipants.map((participant) => participant.lifelineY2),
    ...notes.map((note) => note.y + note.height),
    ...messages.flatMap((message) => message.points.map((point) => point.y)),
    ...activations.map((activation) => activation.y + activation.height),
  ];
  return {
    width: Math.max(...rights, MARGIN) + MARGIN,
    height: Math.max(...bottoms, MARGIN) + MARGIN,
    participants: placedParticipants,
    messages,
    activations,
    notes,
  };
}

interface MeasuredState {
  readonly stateId: string;
  readonly label: string;
  readonly role: "state" | CanvasStateRole;
  readonly nested: boolean;
  readonly width: number;
  readonly height: number;
  readonly children: ReadonlyArray<{
    readonly stateId: string;
    readonly x: number;
    readonly y: number;
  }>;
}

export function layoutCanvasState(block: CanvasStateBlock): CanvasStateLayout {
  const order = block.states.map((state) => String(state.stateId));
  const position = new Map(order.map((stateId, index) => [stateId, index]));
  const byId = new Map(block.states.map((state) => [String(state.stateId), state]));
  const parentOf = new Map(
    block.states.flatMap((state) =>
      state.parentId === undefined ? [] : [[String(state.stateId), String(state.parentId)]],
    ),
  );
  const childrenOf = new Map<string, string[]>();
  const roots: string[] = [];
  for (const stateId of order) {
    const parentId = parentOf.get(stateId);
    if (parentId === undefined || !byId.has(parentId)) {
      roots.push(stateId);
      continue;
    }
    const siblings = childrenOf.get(parentId) ?? [];
    siblings.push(stateId);
    childrenOf.set(parentId, siblings);
  }

  const measured = new Map<string, MeasuredState>();
  const measure = (stateId: string, visiting: ReadonlySet<string>): MeasuredState => {
    const cached = measured.get(stateId);
    if (cached !== undefined) return cached;
    const state = byId.get(stateId);
    const role = state?.role ?? "state";
    const label = state?.label ?? stateId;
    if (state === undefined || visiting.has(stateId) || role === "initial" || role === "final") {
      const leaf = leafState(stateId, label, role);
      measured.set(stateId, leaf);
      return leaf;
    }
    const nextVisiting = new Set(visiting);
    nextVisiting.add(stateId);
    const children = (childrenOf.get(stateId) ?? []).map((childId) =>
      measure(childId, nextVisiting),
    );
    if (children.length === 0) {
      const leaf = leafState(stateId, label, role);
      measured.set(stateId, leaf);
      return leaf;
    }
    const placed = placeRegion(children, block, position, parentOf);
    const width = Math.max(STATE_WIDTH, placed.width + REGION_PAD * 2);
    const height = REGION_HEADER + REGION_PAD + placed.height + REGION_PAD;
    const box: MeasuredState = {
      stateId,
      label,
      role,
      nested: true,
      width,
      height,
      children: placed.boxes,
    };
    measured.set(stateId, box);
    return box;
  };

  const rootMeasures = roots.map((stateId) => measure(stateId, new Set()));
  const placedRoots = placeRegion(rootMeasures, block, position, parentOf);
  const absolute = new Map<string, CanvasStateBox>();
  const placeAbsolute = (stateId: string, x: number, y: number) => {
    const box = measured.get(stateId);
    if (box === undefined || absolute.has(stateId)) return;
    absolute.set(stateId, {
      stateId: box.stateId,
      label: box.label,
      role: box.role,
      nested: box.nested,
      x,
      y,
      width: box.width,
      height: box.height,
    });
    for (const child of box.children) {
      placeAbsolute(
        child.stateId,
        x + REGION_PAD + child.x,
        y + REGION_HEADER + REGION_PAD + child.y,
      );
    }
  };
  for (const root of placedRoots.boxes) {
    placeAbsolute(root.stateId, MARGIN + root.x, MARGIN + root.y);
  }

  const boxes = [...absolute.values()];
  const transitions = block.transitions.flatMap((transition) => {
    const source = absolute.get(String(transition.source));
    const target = absolute.get(String(transition.target));
    if (source === undefined || target === undefined) return [];
    const self = source.stateId === target.stateId;
    const points = self ? selfLoop(source) : routeTransition(source, target, boxes);
    const start = points[0];
    const end = points[points.length - 1];
    if (start === undefined || end === undefined) return [];
    return [
      {
        transitionId: String(transition.transitionId),
        label: transition.label,
        self,
        points,
        labelX: Math.round(labelAt(points).x),
        labelY: Math.round(labelAt(points).y - LABEL_LIFT),
      },
    ];
  });

  const rights = [
    ...boxes.map((box) => box.x + box.width),
    ...transitions.flatMap((transition) => transition.points.map((point) => point.x)),
  ];
  const bottoms = [
    ...boxes.map((box) => box.y + box.height),
    ...transitions.flatMap((transition) => transition.points.map((point) => point.y)),
  ];
  return {
    width: Math.max(...rights, MARGIN) + MARGIN,
    height: Math.max(...bottoms, MARGIN) + MARGIN,
    states: order.flatMap((stateId) => {
      const box = absolute.get(stateId);
      return box === undefined ? [] : [box];
    }),
    transitions,
  };
}

function leafState(stateId: string, label: string, role: "state" | CanvasStateRole): MeasuredState {
  const marker = role === "initial" || role === "final";
  return {
    stateId,
    label,
    role,
    nested: false,
    width: marker ? MARKER : STATE_WIDTH,
    height: marker ? MARKER : STATE_HEIGHT,
    children: [],
  };
}

function placeRegion(
  children: ReadonlyArray<MeasuredState>,
  block: CanvasStateBlock,
  position: ReadonlyMap<string, number>,
  parentOf: ReadonlyMap<string, string>,
): {
  readonly width: number;
  readonly height: number;
  readonly boxes: ReadonlyArray<{
    readonly stateId: string;
    readonly x: number;
    readonly y: number;
  }>;
} {
  if (children.length === 0) return { width: 0, height: 0, boxes: [] };
  const ids = new Set(children.map((child) => child.stateId));
  const ranks = rankRegion(children, block, position, parentOf, ids);
  const byRank = new Map<number, MeasuredState[]>();
  for (const child of children) {
    const rank = ranks.get(child.stateId) ?? 0;
    const row = byRank.get(rank) ?? [];
    row.push(child);
    byRank.set(rank, row);
  }
  const orderedRanks = [...byRank.keys()].sort((left, right) => left - right);
  let y = 0;
  let width = 0;
  const boxes: Array<{ readonly stateId: string; readonly x: number; readonly y: number }> = [];
  for (const rank of orderedRanks) {
    const row = byRank.get(rank) ?? [];
    let x = 0;
    let rowHeight = 0;
    for (const child of row) {
      boxes.push({ stateId: child.stateId, x, y });
      x += child.width + SIBLING_GAP;
      rowHeight = Math.max(rowHeight, child.height);
    }
    width = Math.max(width, x - SIBLING_GAP);
    y += rowHeight + RANK_GAP;
  }
  return { width, height: Math.max(0, y - RANK_GAP), boxes };
}

function rankRegion(
  children: ReadonlyArray<MeasuredState>,
  block: CanvasStateBlock,
  position: ReadonlyMap<string, number>,
  parentOf: ReadonlyMap<string, string>,
  ids: ReadonlySet<string>,
): Map<string, number> {
  const incoming = new Map<string, string[]>(children.map((child) => [child.stateId, []]));
  for (const transition of block.transitions) {
    const source = memberIn(ids, String(transition.source), parentOf);
    const target = memberIn(ids, String(transition.target), parentOf);
    if (source === undefined || target === undefined || source === target) continue;
    if ((position.get(source) ?? 0) < (position.get(target) ?? 0)) {
      incoming.get(target)?.push(source);
    }
  }
  const ranks = new Map<string, number>();
  for (const child of children) {
    if (child.role === "initial") {
      ranks.set(child.stateId, 0);
      continue;
    }
    const sources = incoming.get(child.stateId) ?? [];
    ranks.set(
      child.stateId,
      sources.reduce((highest, source) => Math.max(highest, (ranks.get(source) ?? 0) + 1), 0),
    );
  }
  const ordinaryMax = children.reduce(
    (highest, child) =>
      child.role === "final" ? highest : Math.max(highest, ranks.get(child.stateId) ?? 0),
    0,
  );
  let finalRank = children.some((child) => child.role !== "final") ? ordinaryMax + 1 : 0;
  for (const child of children) {
    if (child.role === "final") {
      ranks.set(child.stateId, finalRank);
      finalRank += 1;
    }
  }
  return ranks;
}

function memberIn(
  ids: ReadonlySet<string>,
  stateId: string,
  parentOf: ReadonlyMap<string, string>,
): string | undefined {
  let current: string | undefined = stateId;
  const seen = new Set<string>();
  while (current !== undefined && !seen.has(current)) {
    if (ids.has(current)) return current;
    seen.add(current);
    current = parentOf.get(current);
  }
  return undefined;
}

function selfLoop(box: CanvasStateBox): ReadonlyArray<CanvasDiagramPoint> {
  const x = box.x + box.width;
  const y = box.y + box.height / 2;
  return [
    { x, y },
    { x: x + SELF_LOOP, y },
    { x: x + SELF_LOOP, y: y + SELF_DROP },
    { x, y: y + SELF_DROP },
  ];
}

function labelAt(points: ReadonlyArray<CanvasDiagramPoint>): CanvasDiagramPoint {
  const start = points[0];
  const end = points[points.length - 1];
  if (start === undefined) return { x: 0, y: 0 };
  if (points.length > 2) return points[1] ?? start;
  if (end === undefined) return start;
  return { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
}

function routeTransition(
  source: CanvasStateBox,
  target: CanvasStateBox,
  boxes: ReadonlyArray<CanvasStateBox>,
): ReadonlyArray<CanvasDiagramPoint> {
  if (contains(source, target)) {
    const x = Math.round(target.x + target.width / 2);
    return [
      { x, y: source.y + REGION_HEADER },
      { x, y: target.y },
    ];
  }
  if (contains(target, source)) {
    const x = Math.round(source.x + source.width / 2);
    return [
      { x, y: source.y + source.height },
      { x, y: target.y + target.height },
    ];
  }
  const direct = borderToBorder(source, target);
  if (!crossesAnother(direct, source, target, boxes)) return direct;
  const right = Math.max(...boxes.map((box) => box.x + box.width)) + 36;
  const fromY = Math.round(source.y + source.height / 2);
  const toY = Math.round(target.y + target.height / 2);
  return [
    { x: source.x + source.width, y: fromY },
    { x: right, y: fromY },
    { x: right, y: toY },
    { x: target.x + target.width, y: toY },
  ];
}

function crossesAnother(
  points: ReadonlyArray<CanvasDiagramPoint>,
  source: CanvasStateBox,
  target: CanvasStateBox,
  boxes: ReadonlyArray<CanvasStateBox>,
): boolean {
  const start = points[0];
  const end = points[points.length - 1];
  if (start === undefined || end === undefined) return false;
  return boxes.some((box) => {
    if (box.stateId === source.stateId || box.stateId === target.stateId) return false;
    return segmentHitsBox(start, end, box);
  });
}

function segmentHitsBox(
  start: CanvasDiagramPoint,
  end: CanvasDiagramPoint,
  box: CanvasStateBox,
): boolean {
  const left = Math.min(start.x, end.x);
  const right = Math.max(start.x, end.x);
  const top = Math.min(start.y, end.y);
  const bottom = Math.max(start.y, end.y);
  const overlapsX = right > box.x && left < box.x + box.width;
  const overlapsY = bottom > box.y && top < box.y + box.height;
  return overlapsX && overlapsY && bottom - top > box.height / 2;
}

function contains(outer: CanvasStateBox, inner: CanvasStateBox): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

function borderToBorder(
  source: CanvasStateBox,
  target: CanvasStateBox,
): ReadonlyArray<CanvasDiagramPoint> {
  const from = center(source);
  const to = center(target);
  const start = roundPoint(borderPoint(source, from, to));
  const end = roundPoint(borderPoint(target, to, from));
  return [start, end];
}

function roundPoint(point: CanvasDiagramPoint): CanvasDiagramPoint {
  return { x: Math.round(point.x), y: Math.round(point.y) };
}

function center(box: CanvasStateBox): CanvasDiagramPoint {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function borderPoint(
  box: CanvasStateBox,
  from: CanvasDiagramPoint,
  toward: CanvasDiagramPoint,
): CanvasDiagramPoint {
  const dx = toward.x - from.x;
  const dy = toward.y - from.y;
  if (dx === 0 && dy === 0) return from;
  const scaleX = dx === 0 ? Infinity : box.width / 2 / Math.abs(dx);
  const scaleY = dy === 0 ? Infinity : box.height / 2 / Math.abs(dy);
  return { x: from.x + dx * Math.min(scaleX, scaleY), y: from.y + dy * Math.min(scaleX, scaleY) };
}
