import * as Haptics from "expo-haptics";

// A phone without a haptic motor refuses; nothing the person did depends on it.
const ignore = () => undefined;

export function hapticSend(): void {
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(ignore);
}
export function hapticSuccess(): void {
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(ignore);
}
export function hapticFailure(): void {
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(ignore);
}
export function hapticSelect(): void {
  Haptics.selectionAsync().catch(ignore);
}
