import { useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from "expo-camera";
import { PAIRING_CODE_PREFIX } from "@octant/domain";
import { MOBILE_COPY } from "../copy";
import { useTheme } from "../../design-system";
import { mobileRadii, mobileSpacing, mobileTypography } from "../theme/tokens";
import { BottomSheet } from "../ui/BottomSheet";

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
  const delivered = useRef(false);
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
    if (delivered.current) return;
    if (!result.data.startsWith(PAIRING_CODE_PREFIX)) {
      setOtherCodeSeen(true);
      return;
    }
    delivered.current = true;
    props.onScanned(result.data);
  };

  const close = () => {
    delivered.current = false;
    setOtherCodeSeen(false);
    props.onClose();
  };

  return (
    <BottomSheet
      onClose={close}
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
