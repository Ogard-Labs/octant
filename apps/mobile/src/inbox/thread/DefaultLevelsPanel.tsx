import { useCallback, useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  changeMobileDefaultLevel,
  changeMobileProjectLevel,
  loadMobileDefaultLevels,
  mobileDefaultLevel,
  mobileProjectLevel,
  mobileThreadLevelChoices,
  type MobileDefaultLevels,
  type MobileRemoteTransport,
} from "@octant/client-runtime";
import { useTheme } from "../../../design-system/theme";
import { space as mobileSpacing } from "../../../design-system/tokens";
import { LevelChoices } from "./ThreadLevelPanel";

export interface DefaultLevelsPanelProps {
  /** What the host said of this session; a restricted session is shown nothing. */
  readonly actsAsHostPerson: boolean;
  readonly mode: "code" | "work";
  /** The Project the open thread belongs to. */
  readonly projectId: string;
  readonly transport: MobileRemoteTransport;
}

/**
 * The mode new threads start in, for the open thread's Project and for this
 * host, set from a phone the host's own person paired as a local window sets
 * them (maintainer decision, 2026-11-12). Closed until asked for, so a thread
 * opens without two more host reads.
 */
export function DefaultLevelsPanel(props: DefaultLevelsPanelProps) {
  const { colors } = useTheme();
  const { transport, mode, projectId } = props;
  const [open, setOpen] = useState(false);
  const [levels, setLevels] = useState<MobileDefaultLevels | "unreadable">();

  const load = useCallback(async () => {
    setLevels((await loadMobileDefaultLevels({ transport, mode, projectId })) ?? "unreadable");
  }, [transport, mode, projectId]);
  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  if (!props.actsAsHostPerson) return null;
  if (!open) {
    return (
      <Pressable
        accessibilityRole="button"
        onPress={() => setOpen(true)}
        style={{
          padding: mobileSpacing.md,
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: mobileSpacing.sm,
        }}
        testID="mobile-default-levels-open"
      >
        <Text style={{ color: colors.textPrimary }}>Project and default modes</Text>
      </Pressable>
    );
  }
  if (levels === undefined) return null;
  if (levels === "unreadable") {
    return (
      <Text accessibilityLiveRegion="polite" style={{ color: colors.textSecondary }}>
        The Project and default modes could not be read from the host.
      </Text>
    );
  }
  const { project, defaults } = levels;
  const choices = mobileThreadLevelChoices(mode);
  return (
    <View style={{ gap: mobileSpacing.md }} testID="mobile-default-levels">
      {project === undefined ? null : (
        <LevelChoices
          choices={choices}
          current={mobileProjectLevel(project)}
          hostId={transport.hostId}
          onChanged={() => void load()}
          onPick={(level) => changeMobileProjectLevel({ transport, project, level })}
          testID="mobile-project-level"
          title={project.name}
          withoutLevelLabel="Follows the default"
        />
      )}
      {defaults === undefined ? null : (
        <LevelChoices
          choices={choices}
          current={mobileDefaultLevel(defaults)}
          hostId={transport.hostId}
          onChanged={() => void load()}
          onPick={async (level) =>
            level === undefined
              ? { status: "refused", message: "The default always has a mode." }
              : changeMobileDefaultLevel({ transport, subject: defaults, level })
          }
          testID="mobile-default-level"
          title="New threads on this host"
        />
      )}
    </View>
  );
}
