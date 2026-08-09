import { MaterialCommunityIcons } from "@expo/vector-icons";
import { Redirect, useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import React, { useEffect, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import NeonButton from "@/src/components/NeonButton";
import SystemChip from "@/src/components/SystemChip";
import { useToast } from "@/src/components/Toast";
import { useObd } from "@/src/context/ObdContext";
import type { Fault } from "@/src/demo/obd";
import { createScan } from "@/src/api/client";
import { colors, font, groupColor, radius, spacing, type } from "@/src/theme";

const CHECK_STEPS = [
  "Engine control module",
  "Transmission",
  "ABS / Brakes",
  "Emissions",
  "Lighting",
  "Body / Electrical",
];

const SEVERITY_COLOR: Record<string, string> = {
  high: colors.error,
  medium: colors.warning,
  low: colors.onSurfaceTertiary,
};

function FaultRow({ fault }: { fault: Fault }) {
  const c = groupColor(fault.group);
  return (
    <View testID={`fault-row-${fault.code}`} style={styles.faultRow}>
      <View style={[styles.codeBox, { borderColor: c }]}>
        <Text style={[styles.code, { color: c }]}>{fault.code}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <View style={styles.faultHead}>
          <SystemChip group={fault.group} />
          <View style={styles.severity}>
            <View
              style={[
                styles.sevDot,
                { backgroundColor: SEVERITY_COLOR[fault.severity] },
              ]}
            />
            <Text
              style={[
                styles.sevText,
                { color: SEVERITY_COLOR[fault.severity] },
              ]}
            >
              {fault.severity}
            </Text>
          </View>
        </View>
        <Text style={styles.faultTitle}>{fault.title}</Text>
        <Text style={styles.faultDesc}>{fault.description}</Text>
      </View>
    </View>
  );
}

export default function FaultCodesScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const toast = useToast();
  const { vehicle, device, runScan } = useObd();

  const [scanning, setScanning] = useState(true);
  const [stepIndex, setStepIndex] = useState(0);
  const [faults, setFaults] = useState<Fault[] | null>(null);
  const [sending, setSending] = useState(false);

  const progress = useRef(new Animated.Value(0)).current;
  const generated = useRef(false);

  useEffect(() => {
    if (!vehicle) return;
    Animated.timing(progress, {
      toValue: 1,
      duration: 3600,
      easing: Easing.inOut(Easing.ease),
      useNativeDriver: false,
    }).start();

    const stepTimer = setInterval(() => {
      setStepIndex((i) => Math.min(i + 1, CHECK_STEPS.length - 1));
    }, 3600 / CHECK_STEPS.length);

    const done = setTimeout(() => {
      if (generated.current) return;
      generated.current = true;
      const result = runScan();
      setFaults(result);
      setScanning(false);
      Haptics.notificationAsync(
        result.length
          ? Haptics.NotificationFeedbackType.Warning
          : Haptics.NotificationFeedbackType.Success,
      );
    }, 3800);

    return () => {
      clearInterval(stepTimer);
      clearTimeout(done);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!vehicle) return <Redirect href="/" />;

  const onSend = async () => {
    if (!faults) return;
    setSending(true);
    try {
      await createScan({
        vehicle,
        faults,
        device_name: device?.name ?? null,
      });
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      toast("Check result saved", "success");
      router.replace("/(tabs)/history");
    } catch (e) {
      toast("Failed to save result. Try again.", "error");
      setSending(false);
    }
  };

  const widthInterp = progress.interpolate({
    inputRange: [0, 1],
    outputRange: ["0%", "100%"],
  });

  const hasFaults = !!faults && faults.length > 0;

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <Pressable
          testID="back-button"
          onPress={() => router.back()}
          hitSlop={12}
          style={styles.backBtn}
        >
          <MaterialCommunityIcons
            name="chevron-left"
            size={26}
            color={colors.onSurface}
          />
        </Pressable>
        <Text style={styles.headerTitle}>Diagnostic Scan</Text>
        <View style={{ width: 26 }} />
      </View>

      {scanning ? (
        <View style={styles.scanning} testID="scanning-view">
          <View style={styles.scanRing}>
            <MaterialCommunityIcons name="radar" size={56} color={colors.brand} />
          </View>
          <Text style={styles.scanTitle}>Reading fault codes…</Text>
          <Text style={styles.scanStep} testID="scan-step">
            {CHECK_STEPS[stepIndex]}
          </Text>
          <View style={styles.progressTrack}>
            <Animated.View style={[styles.progressFill, { width: widthInterp }]} />
          </View>
          <Text style={styles.scanHint}>
            Do not disconnect the adapter during the scan.
          </Text>
        </View>
      ) : (
        <>
          <ScrollView
            contentContainerStyle={{
              padding: spacing.lg,
              paddingBottom: 140,
              gap: spacing.md,
            }}
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.vehicleLine}>
              <MaterialCommunityIcons
                name="car"
                size={16}
                color={colors.onSurfaceTertiary}
              />
              <Text style={styles.vehicleText}>
                {vehicle.make} {vehicle.model} · {vehicle.year}
              </Text>
            </View>

            {hasFaults ? (
              <>
                <View style={styles.summaryBanner} testID="faults-summary">
                  <MaterialCommunityIcons
                    name="alert"
                    size={22}
                    color={colors.warning}
                  />
                  <Text style={styles.summaryText}>
                    {faults!.length} fault{faults!.length > 1 ? "s" : ""} found
                  </Text>
                </View>
                {faults!.map((f) => (
                  <FaultRow key={f.code} fault={f} />
                ))}
              </>
            ) : (
              <View style={styles.clean} testID="no-faults-view">
                <View style={styles.checkCircle}>
                  <MaterialCommunityIcons
                    name="check-bold"
                    size={64}
                    color={colors.success}
                  />
                </View>
                <Text style={styles.cleanTitle}>All Systems Go</Text>
                <Text style={styles.cleanSub}>
                  No stored fault codes were found. Your vehicle passed the
                  diagnostic check.
                </Text>
              </View>
            )}
          </ScrollView>

          <View
            style={[styles.footer, { paddingBottom: insets.bottom + spacing.md }]}
          >
            <NeonButton
              testID="send-result-button"
              label="Send check result"
              icon="cloud-upload"
              loading={sending}
              onPress={onSend}
            />
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surface },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
  },
  backBtn: { width: 26, alignItems: "flex-start" },
  headerTitle: {
    color: colors.onSurface,
    fontFamily: font.displaySemi,
    fontSize: type.xl,
    letterSpacing: 0.5,
  },
  // scanning
  scanning: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.xl },
  scanRing: {
    width: 120,
    height: 120,
    borderRadius: 60,
    borderWidth: 2,
    borderColor: colors.brand,
    backgroundColor: colors.surfaceSecondary,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.xl,
  },
  scanTitle: {
    color: colors.onSurface,
    fontFamily: font.display,
    fontSize: 24,
  },
  scanStep: {
    color: colors.brand,
    fontFamily: font.displayMed,
    fontSize: type.lg,
    letterSpacing: 1,
    marginTop: spacing.sm,
    marginBottom: spacing.xl,
  },
  progressTrack: {
    width: "100%",
    height: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceTertiary,
    overflow: "hidden",
  },
  progressFill: { height: 6, borderRadius: radius.pill, backgroundColor: colors.brand },
  scanHint: {
    color: colors.onSurfaceTertiary,
    fontFamily: font.regular,
    fontSize: type.sm,
    marginTop: spacing.lg,
    textAlign: "center",
  },
  // results
  vehicleLine: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  vehicleText: {
    color: colors.onSurfaceTertiary,
    fontFamily: font.medium,
    fontSize: type.base,
  },
  summaryBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: `${colors.warning}18`,
    borderWidth: 1,
    borderColor: `${colors.warning}55`,
    borderRadius: radius.md,
    padding: spacing.lg,
  },
  summaryText: {
    color: colors.warning,
    fontFamily: font.displaySemi,
    fontSize: type.xl,
    letterSpacing: 0.5,
  },
  faultRow: {
    flexDirection: "row",
    gap: spacing.md,
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.lg,
  },
  codeBox: {
    borderWidth: 1.5,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    alignItems: "center",
    justifyContent: "center",
    minWidth: 74,
    alignSelf: "flex-start",
  },
  code: { fontFamily: font.display, fontSize: type.xl, letterSpacing: 0.5 },
  faultHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.sm,
  },
  severity: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  sevDot: { width: 7, height: 7, borderRadius: 4 },
  sevText: {
    fontFamily: font.semibold,
    fontSize: type.sm,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  faultTitle: {
    color: colors.onSurface,
    fontFamily: font.semibold,
    fontSize: type.lg,
    marginBottom: spacing.xs,
  },
  faultDesc: {
    color: colors.onSurfaceTertiary,
    fontFamily: font.regular,
    fontSize: type.base,
    lineHeight: 20,
  },
  // clean
  clean: { alignItems: "center", paddingTop: spacing["3xl"], gap: spacing.md },
  checkCircle: {
    width: 128,
    height: 128,
    borderRadius: 64,
    borderWidth: 2,
    borderColor: colors.success,
    backgroundColor: `${colors.success}14`,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.md,
  },
  cleanTitle: {
    color: colors.onSurface,
    fontFamily: font.display,
    fontSize: 30,
    letterSpacing: 0.5,
  },
  cleanSub: {
    color: colors.onSurfaceTertiary,
    fontFamily: font.regular,
    fontSize: type.base,
    textAlign: "center",
    lineHeight: 22,
    paddingHorizontal: spacing.xl,
  },
  footer: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
});
