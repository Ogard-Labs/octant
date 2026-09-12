import { randomUUID } from "node:crypto";
import { defaultShellSettings, replaceShellSettings } from "@octant/domain";
import type { StandaloneSkillActivationMap } from "@octant/contracts/shell";
import { SHELL_SETTINGS_AGGREGATE_ID } from "../persistence/shellProjection";
import type { PersistenceService } from "../persistence/persistenceService";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";

export interface StandaloneSkillActivationStore {
  read(): Promise<Readonly<StandaloneSkillActivationMap>>;
  write(activations: Readonly<StandaloneSkillActivationMap>): Promise<void>;
}

/**
 * Persist standalone skill review/trust/enable state in the journaled shell
 * settings aggregate. The key is the source-qualified skill identity, which
 * embeds its content digest, so any file change produces a new key and the
 * prior activation is automatically revoked.
 */
export class ShellSettingsStandaloneSkillActivationStore implements StandaloneSkillActivationStore {
  readonly #persistence: PersistenceService;

  constructor(options: { readonly persistence: PersistenceService }) {
    this.#persistence = options.persistence;
  }

  async read(): Promise<Readonly<StandaloneSkillActivationMap>> {
    const projected = this.#persistence.readShellSettings();
    return projected?.settings.standaloneSkillActivations ?? {};
  }

  async write(activations: Readonly<StandaloneSkillActivationMap>): Promise<void> {
    const projected = this.#persistence.readShellSettings();
    const current = projected?.settings ?? defaultShellSettings();
    const settings = replaceShellSettings(current, {
      ...current,
      standaloneSkillActivations: activations,
    });
    this.#persistence.journal.append({
      aggregate: {
        aggregateType: "shell-settings",
        aggregateId: SHELL_SETTINGS_AGGREGATE_ID,
      },
      expectedVersion: projected?.aggregateVersion ?? 0,
      events: [
        {
          eventId: randomUUID() as never,
          eventName: "shell.settings-replaced",
          eventVersion: 1,
          correlationId: randomUUID() as never,
          actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
          occurredAt: new Date().toISOString() as never,
          payload: { settings },
        },
      ],
    });
  }
}
