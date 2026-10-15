import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from "expo-camera";
import { MOBILE_COPY } from "../copy";
import { useTheme } from "../../design-system";
import { mobileRadii, mobileSpacing, mobileTypography } from "../theme/tokens";
import { BottomSheet } from "../ui/BottomSheet";
import { createPairingScanGate } from "./pairingScanGate";

export interface PairingCodeScannerProps {
  readonly visible: boolean;
  readonly onClose: () => void;
  /** Receives the scanned text of an Octant pairing code, exactly as encoded. */
  readonly onScanned: (code: string) => void;
}

/**
 * The app's own QR scanner for a pairing code. The code has no URL scheme,
 * so the system camera never hands it to an app; only this scanner and the
 * paste field read it. Any other QR code is ignored.
 */
export function PairingCodeScanner(props: PairingCodeScannerProps) {
  const { colors } = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const [otherCodeSeen, setOtherCodeSeen] = useState(false);
  const [gate] = useState(createPairingScanGate);
  // Every opening starts afresh, however the sheet was closed: a code whose
  // pairing failed must scan again the next time.
  useEffect(() => {
    if (!props.visible) return;
    gate.reset();
    setOtherCodeSeen(false);
  }, [gate, props.visible]);
  const styles = useMemo(
    () =>
      StyleSheet.create({
        body: { gap: mobileSpacing.md },
        camera: {
          aspectRatio: 1,
          width: "100%",
          borderRadius: mobileRadii.md,
          overflow: "hidden",
        },
        help: {
          color: colors.textSecondary,
          fontSize: mobileTypography.caption.fontSize,
          lineHeight: 18,
        },
        button: {
          backgroundColor: colors.accent,
          paddingVertical: 14,
          alignItems: "center",
          borderRadius: mobileRadii.pill,
        },
        buttonLabel: {
          color: colors.sendLabel,
          fontWeight: "500",
          fontSize: mobileTypography.body.fontSize,
        },
      }),
    [colors],
  );

  const scanned = (result: BarcodeScanningResult) => {
    const verdict = gate.offer(result.data);
    if (verdict === "other") setOtherCodeSeen(true);
    if (verdict === "deliver") props.onScanned(result.data);
  };

  return (
    <BottomSheet
      onClose={props.onClose}
      testID="mobile-pairing-scanner"
      title={MOBILE_COPY.pairScanTitle}
      visible={props.visible}
    >
      <View style={styles.body}>
        {permission?.granted === true ? (
          <>
            <CameraView
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              facing="back"
              onBarcodeScanned={scanned}
              style={styles.camera}
            />
            <Text style={styles.help}>
              {otherCodeSeen ? MOBILE_COPY.pairScanOtherCode : MOBILE_COPY.pairScanHint}
            </Text>
          </>
        ) : (
          <>
            <Text style={styles.help}>
              {permission?.canAskAgain === false
                ? MOBILE_COPY.pairScanCameraDenied
                : MOBILE_COPY.pairScanCameraAsk}
            </Text>
            {permission?.canAskAgain === false ? null : (
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  void requestPermission();
                }}
                style={styles.button}
                testID="mobile-pairing-scanner-allow"
              >
                <Text style={styles.buttonLabel}>Allow camera</Text>
              </Pressable>
            )}
          </>
        )}
      </View>
    </BottomSheet>
  );
}
