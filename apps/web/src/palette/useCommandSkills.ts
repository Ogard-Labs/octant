import type { ExtensionClient } from "@octant/client-runtime/extension-client";
import { useEffect, useState } from "react";
import type { CommandSkill } from "./buildOctantCommands";

const NO_SKILLS: ReadonlyArray<CommandSkill> = [];

/** How often the host is re-read for extension state it may have changed. */
const DEFAULT_REFRESH_MS = 5_000;

export interface CommandSkillsOptions {
  readonly refreshMs?: number;
}

/**
 * The skills this host says are installed, available, and not blocked.
 *
 * Only the host's own snapshot is read; the renderer never assumes a skill
 * exists. A blocked or unavailable skill is left out entirely rather than
 * offered and refused, and if the extension service cannot answer at all the
 * answer is an empty list, so the `/` affordance simply has no Skills group.
 * An empty list is "nothing is offered", never a claim that this host has no
 * skills: before the first answer, and after a failed one, the affordance says
 * nothing about skills rather than saying there are none.
 *
 * The host owns this state and changes it without telling the renderer —
 * enabling, installing, disabling, or removing a skill in Settings — so the
 * snapshot is re-read on the same in-flight-guarded interval the other
 * extension-state readers use. Without it a newly enabled skill stayed
 * unreachable and a disabled one stayed offered until the app was reloaded.
 * A re-read that returns the same skills leaves the list identical, so the
 * commands built from it do not churn.
 *
 * Listing is not authorization. The composer still resolves the chosen
 * reference through the host's ordinary draft-resolution path, which re-checks
 * the catalog epoch and the effective state for the active scope.
 */
export function useCommandSkills(
  client: ExtensionClient,
  options: CommandSkillsOptions = {},
): ReadonlyArray<CommandSkill> {
  const [skills, setSkills] = useState<ReadonlyArray<CommandSkill>>(NO_SKILLS);
  const refreshMs = options.refreshMs ?? DEFAULT_REFRESH_MS;

  useEffect(() => {
    let active = true;
    let inFlight = false;
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const snapshot = await client.snapshot();
        if (!active) return;
        setSkills((current) =>
          sameSkills(
            current,
            (snapshot.skills ?? [])
              .filter(
                (record) => record.skill.available && record.effectiveState.kind === "effective",
              )
              .map((record) => ({
                skillId: String(record.skill.qualifiedId),
                displayName: record.displayName,
              })),
          ),
        );
      } catch {
        if (active) setSkills(NO_SKILLS);
      } finally {
        inFlight = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), Math.max(10, refreshMs));
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [client, refreshMs]);

  return skills;
}

/** Keep the previous array when the host reports the same skills. */
function sameSkills(
  current: ReadonlyArray<CommandSkill>,
  next: ReadonlyArray<CommandSkill>,
): ReadonlyArray<CommandSkill> {
  if (current.length !== next.length) return next;
  return current.every(
    (skill, index) =>
      skill.skillId === next[index]?.skillId && skill.displayName === next[index]?.displayName,
  )
    ? current
    : next;
}
