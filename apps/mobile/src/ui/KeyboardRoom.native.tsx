import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import type { KeyboardRoomProps } from "./KeyboardRoom";

/**
 * A view that keeps its foot on the keyboard, frame by frame. The system's own
 * notices name where the keyboard is going and not where it ends: the bar of
 * suggestions over it comes and goes after them.
 */
export function KeyboardRoom(props: KeyboardRoomProps) {
  const { height } = useReanimatedKeyboardAnimation();
  const leaves = props.leaves ?? 0;
  const room = useAnimatedStyle(
    () => ({ paddingBottom: Math.max(0, -height.value - leaves) }),
    [leaves],
  );
  return (
    <Animated.View style={[props.style, room]} testID={props.testID}>
      {props.children}
    </Animated.View>
  );
}
