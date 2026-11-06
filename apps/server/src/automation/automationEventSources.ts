import { Schema } from "effect";
import {
  AutomationIntegrationEvent,
  AutomationEventSourceWindow,
  type AutomationDefinition,
  type AutomationDefinitionDraft,
  type AutomationEventSourceCheckpoint,
  type UtcTimestamp,
} from "@octant/contracts";
import type { IntegrationEventSourceProvider } from "@octant/plugin-api/integration";
import type { AutomationProjection } from "./automationProjection";
import type { AutomationSchedulerService } from "./automationSchedulerService";
import {
  initialAutomationEventCheckpoint,
  reconcileAutomationEventObservation,
} from "./automationEventSourceState";

export interface AutomationEventSourcePreparation {
  readonly definition: AutomationDefinitionDraft;
  readonly checkpoint?: AutomationEventSourceCheckpoint;
  readonly current: () => boolean;
}

export async function prepareAutomationEventDefinition(input: {
  readonly definition: AutomationDefinitionDraft;
  readonly sources: IntegrationEventSourceProvider;
  readonly previous?: AutomationDefinition;
  readonly checkpoint?: AutomationEventSourceCheckpoint;
  readonly rearm: boolean;
  readonly current: () => boolean;
  readonly signal: AbortSignal;
  readonly now: () => UtcTimestamp;
}): Promise<AutomationEventSourcePreparation | undefined> {
  const trigger = input.definition.trigger;
  if (trigger.kind !== "integration-event" || !input.current()) return undefined;
  const source = await input.sources.bind(trigger, input.signal);
  if (source === undefined || !source.current() || !input.current()) return undefined;
  const previous = input.previous?.trigger;
  if (
    previous !== undefined &&
    !input.rearm &&
    (previous.kind !== "integration-event" ||
      previous.sourceIdentity !== source.identity ||
      JSON.stringify(previous.filters) !== JSON.stringify(trigger.filters))
  )
    return undefined;
  const checkpoint =
    input.previous === undefined || input.rearm
      ? {
          ...initialAutomationEventCheckpoint(source.identity, input.now()),
          observationRevision: input.checkpoint?.observationRevision ?? 0,
        }
      : undefined;
  return {
    definition: {
      ...input.definition,
      trigger: { ...trigger, sourceIdentity: source.identity, sourceLabel: source.label },
    },
    ...(checkpoint === undefined ? {} : { checkpoint }),
    current: () => input.current() && !input.signal.aborted && source.current(),
  };
}

interface AutomationEventSourcesOptions {
  readonly projection: AutomationProjection;
  readonly scheduler: Pick<AutomationSchedulerService, "commitEventObservation">;
  readonly sources: IntegrationEventSourceProvider;
  readonly current: (definition: AutomationDefinition) => boolean;
  readonly activity?: (definition: AutomationDefinition) => "quiet" | "busy" | "unknown";
  readonly now: () => UtcTimestamp;
  readonly monotonic: () => number;
  readonly wake: () => void;
}

/** Polling is scheduled by the host's existing routine loop; this owns no timer or runner. */
export class AutomationEventSources {
  readonly #options: AutomationEventSourcesOptions;
  readonly #active = new Map<string, AbortController>();
  readonly #next = new Map<string, number>();
  readonly #observed = new Set<string>();
  #stopped = false;
  constructor(options: AutomationEventSourcesOptions) {
    this.#options = options;
  }

  reconcile(): number | undefined {
    if (this.#stopped) return undefined;
    let wake: number | undefined;
    const now = this.#options.monotonic();
    for (const definition of this.#options.projection.listDefinitions()) {
      if (definition.lifecycle !== "enabled" || definition.trigger.kind !== "integration-event")
        continue;
      const id = String(definition.id);
      const checkpoint = this.#options.projection.getEventSource(definition.id);
      if (checkpoint?.phase === "held" || checkpoint?.phase === "needs-rearm") continue;
      const next = this.#next.get(id) ?? now;
      if (next > now) wake = Math.min(wake ?? next, next);
      else if (!this.#active.has(id) && this.#active.size < 2) {
        const controller = new AbortController();
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]);
        let onAbort: (() => void) | undefined;
        const expired = new Promise<void>((resolve) => {
          onAbort = () => resolve();
          signal.addEventListener("abort", onAbort, { once: true });
        });
        this.#active.set(id, controller);
        this.#next.set(id, now + definition.trigger.pollMinutes * 60_000);
        void Promise.race([this.#poll(definition, signal), expired])
          .catch(() => this.#recordUnavailable(definition))
          .finally(() => {
            if (signal.aborted && !controller.signal.aborted) this.#recordUnavailable(definition);
            if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
            this.#active.delete(id);
            if (!this.#stopped) this.#options.wake();
          });
      }
    }
    return wake;
  }

  stop(): void {
    this.#stopped = true;
    for (const controller of this.#active.values()) controller.abort();
    this.#active.clear();
  }

  #recordUnavailable(definition: AutomationDefinition): void {
    if (
      this.#stopped ||
      !this.#options.current(definition) ||
      this.#options.projection.getDefinition(definition.id)?.version !== definition.version ||
      this.#options.projection.activeRun(definition.id) !== undefined ||
      definition.trigger.kind !== "integration-event" ||
      definition.trigger.sourceIdentity === undefined
    )
      return;
    const previous =
      this.#options.projection.getEventSource(definition.id) ??
      initialAutomationEventCheckpoint(definition.trigger.sourceIdentity, this.#options.now());
    try {
      this.#options.scheduler.commitEventObservation({
        automationId: definition.id,
        expectedVersion: definition.version,
        previousObservationRevision: previous.observationRevision,
        current: () => !this.#stopped && this.#options.current(definition),
        decision: {
          kind: "checkpoint",
          checkpoint: {
            ...previous,
            observationRevision: previous.observationRevision + 1,
            phase: "unavailable",
            reason: "source-unavailable",
          },
        },
      });
    } catch {
      /* A failed journal append retains the previous cursor. */
    }
  }

  async #poll(definition: AutomationDefinition, signal: AbortSignal): Promise<void> {
    if (
      definition.trigger.kind !== "integration-event" ||
      definition.trigger.sourceIdentity === undefined
    )
      return;
    const trigger = definition.trigger;
    const identity = trigger.sourceIdentity;
    if (identity === undefined) return;
    const current = () =>
      !this.#stopped &&
      !signal.aborted &&
      this.#options.projection.getDefinition(definition.id)?.version === definition.version &&
      this.#options.current(definition);
    if (!current()) return;
    const previous =
      this.#options.projection.getEventSource(definition.id) ??
      initialAutomationEventCheckpoint(identity, this.#options.now());
    const source = await this.#options.sources.bind(trigger, signal);
    if (!current()) return;
    const complete =
      source !== undefined && source.identity === trigger.sourceIdentity && source.current();
    const result = complete ? await source.read(signal) : undefined;
    if (!current()) return;
    const unavailable = (reason: "source-unavailable" | "source-limit" | "source-changed") => {
      this.#options.scheduler.commitEventObservation({
        automationId: definition.id,
        expectedVersion: definition.version,
        previousObservationRevision: previous.observationRevision,
        current,
        decision: {
          kind: "checkpoint",
          checkpoint: {
            ...previous,
            observationRevision: previous.observationRevision + 1,
            phase: reason === "source-changed" ? "needs-rearm" : "unavailable",
            reason,
          },
        },
      });
    };
    if (source !== undefined && source.identity !== trigger.sourceIdentity) {
      unavailable("source-changed");
      return;
    }
    if (result?.kind !== "complete" || source === undefined) {
      unavailable(result?.kind === "unavailable" ? result.reason : "source-unavailable");
      if (result?.kind === "unavailable" && result.retryAfterSeconds !== undefined)
        this.#next.set(
          String(definition.id),
          this.#options.monotonic() + Math.max(60, Math.min(3600, result.retryAfterSeconds)) * 1000,
        );
      return;
    }
    let observed;
    try {
      observed = Schema.decodeUnknownSync(
        Schema.Struct({
          events: Schema.Array(AutomationIntegrationEvent).pipe(Schema.maxItems(256)),
          window: Schema.optional(AutomationEventSourceWindow),
        }),
      )({
        events: result.events,
        ...(result.window === undefined ? {} : { window: result.window }),
      });
    } catch {
      unavailable("source-limit");
      return;
    }
    if (!source.current() || !current()) return;
    const gap =
      previous.baselineReady &&
      (!this.#observed.has(String(definition.id)) ||
        Date.parse(this.#options.now()) - Date.parse(previous.observedAt) >
          trigger.pollMinutes * 120_000);
    const activity = this.#options.activity?.(definition);
    const decision =
      activity === "unknown"
        ? {
            kind: "checkpoint" as const,
            checkpoint: {
              ...previous,
              observationRevision: previous.observationRevision + 1,
              observedAt: this.#options.now(),
              phase: "needs-rearm" as const,
              reason: "activity-history-limit" as const,
            },
          }
        : reconcileAutomationEventObservation({
            previous,
            trigger,
            events: observed.events,
            ...(observed.window === undefined ? {} : { window: observed.window }),
            semantics: source.semantics,
            observedAt: this.#options.now(),
            coverageGap: gap,
            missedRunPolicy: definition.missedRunPolicy,
            busy:
              activity === "busy" ||
              this.#options.projection.activeRun(definition.id) !== undefined,
          });
    const committed = this.#options.scheduler.commitEventObservation({
      automationId: definition.id,
      expectedVersion: definition.version,
      previousObservationRevision: previous.observationRevision,
      decision,
      current: () => current() && source.current(),
    });
    if (committed === "committed") this.#observed.add(String(definition.id));
  }
}
