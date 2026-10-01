import type { ExtensionClient } from "@octant/client-runtime/extension-client";
import { useEffect, useState } from "react";
import { documentIsVisible, scheduleVisibleInterval } from "../polling/documentVisibility";
import type { CommandPluginServer, CommandSkill } from "./buildOctantCommands";

const NO_SKILLS: ReadonlyArray<CommandSkill> = [];
const NO_PLUGIN_SERVERS: ReadonlyArray<CommandPluginServer> = [];

/** How often the host is re-read for extension state it may have changed. */
const DEFAULT_REFRESH_MS = 5_000;

export interface CommandSkillsOptions {
  readonly refreshMs?: number;
  readonly changeRevision?: number;
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
  return useCommandExtensions(client, options).skills;
}

/**
 * The skills, and the plugin MCP servers, this host says are installed and
 * effective, read from one snapshot. A plugin's MCP server is offered in every
 * composer the way a skill is; the host still decides at send whether the
 * thread's mode, Project, and provider may use it.
 */
export function useCommandExtensions(
  client: ExtensionClient,
  options: CommandSkillsOptions = {},
): {
  readonly skills: ReadonlyArray<CommandSkill>;
  readonly pluginServers: ReadonlyArray<CommandPluginServer>;
} {
  const [skills, setSkills] = useState<ReadonlyArray<CommandSkill>>(NO_SKILLS);
  const [pluginServers, setPluginServers] =
    useState<ReadonlyArray<CommandPluginServer>>(NO_PLUGIN_SERVERS);
  const refreshMs = options.refreshMs ?? DEFAULT_REFRESH_MS;

  useEffect(() => {
    let active = true;
    let inFlight = false;
    const load = async () => {
      if (!documentIsVisible() || inFlight) return;
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
        setPluginServers((current) =>
          samePluginServers(
            current,
            snapshot.packages.flatMap((packageState) => {
              const slug = packageState.slug;
              if (slug === undefined) return [];
              return packageState.components
                .filter(
                  (component) =>
                    component.component.kind === "mcp-server" &&
                    component.effectiveState.kind === "effective",
                )
                .map((component) => ({
                  reference: `@${slug}/${component.component.id}`,
                  displayName: component.component.displayName,
                  pluginName: packageState.displayName ?? slug,
                }));
            }),
          ),
        );
      } catch {
        if (active) {
          setSkills(NO_SKILLS);
          setPluginServers(NO_PLUGIN_SERVERS);
        }
      } finally {
        inFlight = false;
      }
    };
    let stop: () => void;
    if (refreshMs <= 0) {
      const loadWhenVisible = () => {
        if (documentIsVisible()) void load();
      };
      loadWhenVisible();
      if (typeof document === "undefined") {
        stop = () => undefined;
      } else {
        document.addEventListener("visibilitychange", loadWhenVisible);
        stop = () => document.removeEventListener("visibilitychange", loadWhenVisible);
      }
    } else {
      stop = scheduleVisibleInterval(() => void load(), Math.max(10, refreshMs), {
        runImmediately: true,
      });
    }
    return () => {
      active = false;
      stop();
    };
  }, [client, options.changeRevision, refreshMs]);

  return { skills, pluginServers };
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

/** Keep the previous array when the host reports the same plugin servers. */
function samePluginServers(
  current: ReadonlyArray<CommandPluginServer>,
  next: ReadonlyArray<CommandPluginServer>,
): ReadonlyArray<CommandPluginServer> {
  if (current.length !== next.length) return next;
  return current.every(
    (server, index) =>
      server.reference === next[index]?.reference &&
      server.displayName === next[index]?.displayName &&
      server.pluginName === next[index]?.pluginName,
  )
    ? current
    : next;
}
