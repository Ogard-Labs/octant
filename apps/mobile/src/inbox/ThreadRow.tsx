import { useState } from "react";
import type { MobileInboxRow } from "@octant/client-runtime";
import { useTheme } from "../../design-system";
import { formatScreenshotSafeLabel } from "../security/screenshotSafeLabel";
import { useMobileSession } from "../session/MobileSessionContext";
import { ListRow } from "../ui/NativeChrome";
import { inboxWorkStatus } from "./inboxWorkPresentation";
import { useMobileThreads } from "./MobileThreadsContext";
import { ThreadRowActionsSheet } from "./ThreadRowActionsSheet";
import {
  threadModeIcon,
  threadModeLabel,
  threadRowDetail,
  threadStatusTone,
} from "./threadRowPresentation";

/**
 * One thread in any list: what it is, where it runs, what it waits for, and
 * its state in words. A long press offers what the row menu offers.
 */
export function ThreadRow(props: {
  readonly row: MobileInboxRow;
  readonly last: boolean;
  readonly onOpen: (row: MobileInboxRow) => void;
  /** False under a Project heading, which already names it. */
  readonly showProject?: boolean;
}) {
  const { row } = props;
  const { colors } = useTheme();
  const { transports } = useMobileSession();
  const { hostLabel, projectName, refresh } = useMobileThreads();
  const [actionsOpen, setActionsOpen] = useState(false);
  const project = props.showProject === false ? undefined : projectName(row);
  return (
    <>
      <ListRow
        accessory="none"
        detail={threadRowDetail(row, [
          ...(project === undefined ? [] : [formatScreenshotSafeLabel(project)]),
          threadModeLabel(row.mode),
          hostLabel(row.hostId),
        ])}
        icon={threadModeIcon(row.mode)}
        label={formatScreenshotSafeLabel(row.title)}
        last={props.last}
        onLongPress={() => setActionsOpen(true)}
        onPress={() => props.onOpen(row)}
        testID={`mobile-home-thread-row-${row.mode}-${row.threadId}`}
        value={inboxWorkStatus(row.status, row.reviewState, row.live)}
        valueTone={threadStatusTone(row, colors)}
      />
      {actionsOpen ? (
        <ThreadRowActionsSheet
          onChanged={() => void refresh()}
          onClose={() => setActionsOpen(false)}
          row={row}
          transport={transports.find((transport) => transport.hostId === row.hostId)}
        />
      ) : null}
    </>
  );
}
