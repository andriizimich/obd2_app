import { MaterialCommunityIcons } from "@expo/vector-icons";
import { Redirect, useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import React, { useCallback, useEffect, useRef, useState } from "react";
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

import FaultRow from "@/src/components/FaultRow";
import NeonButton from "@/src/components/NeonButton";
import { useToast } from "@/src/components/Toast";
import { useObd } from "@/src/context/ObdContext";
import { carWasRead } from "@/src/obd/diagnostics";
import type { DiagnosticReport } from "@/src/obd/types";
import { sendReport } from "@/src/api/telegram";
import { colors, font, radius, spacing, type } from "@/src/theme";

/**
 * The pass can be over in well under a second on a fast car, and a progress
 * screen that flashes is unreadable — hold it this long at minimum so the
 * steps are actually seen. Not a fixed duration: a slow car takes as long
 * as it takes.
 */
const MIN_SCAN_MS = 800;

export default function FaultCodesScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const toast = useToast();
  const { vehicle, runScan } = useObd();

  const [phase, setPhase] = useState<"scanning" | "done" | "error">("scanning");
  const [step, setStep] = useState({ stage: "Contacting the adapter…", index: 0, total: 0 });
  const [report, setReport] = useState<DiagnosticReport | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const progress = useRef(new Animated.Value(0)).current;
  const started = useRef(false);
  const cancelled = useRef(false);

  const scan = useCallback(async () => {
    setPhase("scanning");
    setScanError(null);
    progress.setValue(0);
    const startedAt = Date.now();
    try {
      const result = await runScan({
        onProgress: (p) => {
          if (cancelled.current) return;
          setStep(p);
          // The bar tracks the pass that is actually running — the stage
          // list comes from the orchestrator, not from a fixed script.
          Animated.timing(progress, {
            toValue: p.total > 0 ? p.index / p.total : 0,
            duration: 250,
            easing: Easing.out(Easing.ease),
            useNativeDriver: false,
          }).start();
        },
      });
      const remaining = MIN_SCAN_MS - (Date.now() - startedAt);
      if (remaining > 0) {
        await new Promise((resolve) => setTimeout(resolve, remaining));
      }
      if (cancelled.current) return;
      Animated.timing(progress, {
        toValue: 1,
        duration: 200,
        useNativeDriver: false,
      }).start();
      setReport(result);
      setPhase("done");
      Haptics.notificationAsync(
        result.faults.length
          ? Haptics.NotificationFeedbackType.Warning
          : Haptics.NotificationFeedbackType.Success,
      );
    } catch (err) {
      if (cancelled.current) return;
      setScanError(
        err instanceof Error ? err.message : "The scan could not be completed.",
      );
      setPhase("error");
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  }, [runScan, progress]);

  useEffect(
    () => () => {
      cancelled.current = true;
    },
    [],
  );

  useEffect(() => {
    if (!vehicle || started.current) return;
    started.current = true;
    void scan();
  }, [vehicle, scan]);

  if (!vehicle) return <Redirect href="/" />;

  const onSend = async () => {
    if (!report) return;
    setSending(true);
    try {
      await sendReport(vehicle, report);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      toast("Check result sent", "success");
      router.replace("/dashboard");
    } catch {
      toast("Failed to send result. Try again.", "error");
      setSending(false);
    }
  };

  const widthInterp = progress.interpolate({
    inputRange: [0, 1],
    outputRange: ["0%", "100%"],
  });

  const faults = report?.faults ?? [];
  const hasFaults = faults.length > 0;
  // "Nothing was found" and "nothing could be read" are different answers,
  // and only the coverage list can tell them apart. Without this check an
  // ECU that refuses every request would render as a clean bill of health.
  // The list itself is no longer drawn — the report still carries it, and so
  // does the chat — but the distinction it makes is not a display detail, so
  // the computation stays.
  const readable = report ? carWasRead(report.coverage) : false;
  // The pipeline names an unknown car "Unknown" (`unidentifiedVehicle`), which
  // is a placeholder for the code, not a word for a driver — and this line is
  // now the whole identity on screen.
  const named = !!vehicle.make && vehicle.make !== "Unknown";
  const carName = vehicle.model ? `${vehicle.make} ${vehicle.model}` : vehicle.make;
  // An unread year is 0, and "· 0" reads as a real model year.
  const carLine =
    vehicle.year > 0 ? `${carName} · ${vehicle.year}` : carName;

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

      {phase === "scanning" && (
        <View style={styles.scanning} testID="scanning-view">
          <View style={styles.scanRing}>
            <MaterialCommunityIcons name="radar" size={56} color={colors.brand} />
          </View>
          <Text style={styles.scanTitle}>Reading fault codes…</Text>
          <Text style={styles.scanStep} testID="scan-step">
            {step.stage}
          </Text>
          <View style={styles.progressTrack}>
            <Animated.View style={[styles.progressFill, { width: widthInterp }]} />
          </View>
          <Text style={styles.scanHint}>
            Do not disconnect the adapter during the scan.
          </Text>
        </View>
      )}

      {phase === "error" && (
        <View style={styles.scanning} testID="scan-error-view">
          <View style={[styles.scanRing, { borderColor: colors.error }]}>
            <MaterialCommunityIcons
              name="alert-circle-outline"
              size={56}
              color={colors.error}
            />
          </View>
          <Text style={styles.scanTitle}>Scan failed</Text>
          <Text style={styles.errorText}>{scanError}</Text>
          <View style={styles.retry}>
            <NeonButton
              testID="retry-scan-button"
              label="Retry scan"
              icon="refresh"
              onPress={() => void scan()}
            />
          </View>
        </View>
      )}

      {phase === "done" && report && (
        <>
          <ScrollView
            contentContainerStyle={{
              padding: spacing.lg,
              paddingBottom: 140,
              gap: spacing.md,
            }}
            showsVerticalScrollIndicator={false}
          >
            {/* The result is the car and the codes. Mileage, the lamp, the
                list of requests and the adapter's own words are all in the
                report — the chat shows them and the dashboard's evidence
                panel shows the raw bytes — but none of them is what a driver
                opened this screen to read. */}
            <View style={styles.vehicleLine}>
              <MaterialCommunityIcons
                name="car"
                size={16}
                color={colors.onSurfaceTertiary}
              />
              <Text style={styles.vehicleText}>
                {named ? carLine : "Vehicle not identified"}
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
                    {faults.length} fault{faults.length > 1 ? "s" : ""} found
                  </Text>
                </View>
                {faults.map((f) => (
                  <FaultRow key={`${f.code}-${f.status ?? "stored"}-${f.moduleId ?? "x"}`} fault={f} />
                ))}
              </>
            ) : readable ? (
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
            ) : (
              <View style={styles.clean} testID="nothing-read-view">
                <View style={[styles.checkCircle, { borderColor: colors.warning, backgroundColor: `${colors.warning}14` }]}>
                  <MaterialCommunityIcons
                    name="help-circle-outline"
                    size={64}
                    color={colors.warning}
                  />
                </View>
                <Text style={styles.cleanTitle}>Nothing could be read</Text>
                <Text style={styles.cleanSub}>
                  The adapter answered, but this vehicle did not return any
                  fault-code data. That is not a clean bill of health. Send the
                  result — the report says what each request returned.
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
  // scanning / error
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
    textAlign: "center",
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
  errorText: {
    color: colors.onSurfaceTertiary,
    fontFamily: font.regular,
    fontSize: type.base,
    textAlign: "center",
    lineHeight: 20,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  retry: { alignSelf: "stretch", marginTop: spacing.xl },
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
  // clean / nothing-read
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
