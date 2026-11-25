import { SegmentedControl as SystemSegmentedControl } from "@expo/ui/community/segmented-control";
import { useTheme } from "../../design-system";
import type { SegmentedControlProps } from "./SegmentedControl";

/** The system's own segmented control. */
export function SegmentedControl<Id extends string>(props: SegmentedControlProps<Id>) {
  const { scheme } = useTheme();
  return (
    <SystemSegmentedControl
      appearance={scheme}
      onChange={(event) => {
        const option = props.options[event.nativeEvent.selectedSegmentIndex];
        if (option !== undefined) props.onSelect(option.id);
      }}
      selectedIndex={props.options.findIndex((option) => option.id === props.selected)}
      {...(props.testID === undefined ? {} : { testID: props.testID })}
      values={props.options.map((option) => option.label)}
    />
  );
}
