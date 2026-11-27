import { useRef } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Swipeable, { type SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import { useTheme } from "../../design-system";
import { hapticSelect } from "../ui/haptics";
import { Icon } from "../ui/Icon";
import type { SwipeAction, ThreadRowSwipeProps } from "./ThreadRowSwipe";

const ACTION_WIDTH = 76;

/**
 * A thread row that swipes to its everyday actions. A screen reader has them
 * in the row's own menu, so the swiped ones are not read out again.
 */
export function ThreadRowSwipe(props: ThreadRowSwipeProps) {
  const { colors } = useTheme();
  const swipe = useRef<SwipeableMethods>(null);
  if (props.leading.length === 0 && props.trailing.length === 0) return props.children;
  const actions = (offered: ReadonlyArray<SwipeAction>) =>
    offered.length === 0
      ? undefined
      : () => (
          <View
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={styles.actions}
          >
            {offered.map((action) => (
              <Pressable
                key={action.id}
                onPress={() => {
                  swipe.current?.close();
                  action.onPress();
                }}
                style={[styles.action, { backgroundColor: action.fill }]}
              >
                <Icon color={colors.sendLabel} name={action.icon} size={19} />
                <Text
                  maxFontSizeMultiplier={1.3}
                  numberOfLines={1}
                  style={[styles.label, { color: colors.sendLabel }]}
                >
                  {action.label}
                </Text>
              </Pressable>
            ))}
          </View>
        );
  const left = actions(props.leading);
  const right = actions(props.trailing);
  return (
    <Swipeable
      friction={1.6}
      leftThreshold={ACTION_WIDTH * 0.6}
      onSwipeableWillOpen={() => hapticSelect()}
      overshootFriction={8}
      ref={swipe}
      rightThreshold={ACTION_WIDTH * 0.6}
      {...(left === undefined ? {} : { renderLeftActions: left })}
      {...(right === undefined ? {} : { renderRightActions: right })}
    >
      <View style={{ backgroundColor: colors.canvas }}>{props.children}</View>
    </Swipeable>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: "row" },
  action: { width: ACTION_WIDTH, alignItems: "center", justifyContent: "center", gap: 3 },
  label: { fontSize: 12, fontWeight: "600" },
});
