import type { ReactNode } from "react";
import { StyleSheet } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";

/** What swipes, and the views that ride on the keyboard, need above them. */
export function GestureRoot(props: { readonly children: ReactNode }) {
  return (
    <GestureHandlerRootView style={styles.root}>
      <KeyboardProvider>{props.children}</KeyboardProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({ root: { flex: 1 } });
