import type { ReactNode } from "react";
import { StyleSheet } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";

/** What swipes need above them. */
export function GestureRoot(props: { readonly children: ReactNode }) {
  return <GestureHandlerRootView style={styles.root}>{props.children}</GestureHandlerRootView>;
}

const styles = StyleSheet.create({ root: { flex: 1 } });
