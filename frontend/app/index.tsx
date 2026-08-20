import { MaterialCommunityIcons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import { useCallback, useEffect, useRef, useState } from "react";
import React from "react";
import {
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import Logo from "@/src/components/Logo";
import NeonButton from "@/src/components/NeonButton";
import { useObd } from "@/src/context/ObdContext";
import { getDemoTransport, getTransport, loadMode, saveMode } from "@/src/obd";
import type { Identification } from "@/src/obd/identify";
import { identifyVehicle } from "@/src/obd/identify";
import type { OdbMode } from "@/src/obd/transport";
import { OdbScanError } from "@/src/obd/transport";
import type { ObdDevice } from "@/src/obd/types";
import { colors, font, radius, spacing, type } from "@/src/theme";

const HERO =
  "https://images.unsplash.com/photo-1627819098699-d8ae75db1112?crop=entropy&cs=srgb&fm=jpg&ixid=M3w4NjA1NTN8MHwxfHNlYXJjaHwxfHxhYnN0cmFjdCUyMG5lb24lMjBibHVlJTIwbGlnaHQlMjBzdHJlYWtzJTIwYmxhY2slMjBiYWNrZ3JvdW5kfGVufDB8fHx8MTc4NjI5Mjg1MXww&ixlib=rb-4.1.0&q=85";

type Phase = "idle" | "scanning" | "found" | "connecting" | "error";

type ErrorKind =
  | "none-found"
  | "bluetooth-off"
  | "permission-denied"
  | "unsupported"
  | "handshake"
  | "disconnected";

function Radar({ active, color }: { active: boolean; color: string }) {
  const r1 = useRef(new Animated.Value(0)).current;
  const r2 = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!active) {
      r1.setValue(0);
      r2.setValue(0);
      return;
    }
    const mk = (v: Animated.Value, delay: number) =>
      Animated.loop(
        Animated.timing(v, {
          toValue: 1,
          duration: 2000,
          delay,
          easing: Easing.out(Easing.ease),
          useNativeDriver: true,
        }),
      );
    const a = mk(r1, 0);
    const b = mk(r2, 1000);
    a.start();
    b.start();
    return () => {
      a.stop();
      b.stop();
    };
  }, [active, r1, r2]);

  const ring = (v: Animated.Value) => ({
    opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0.55, 0] }),
    transform: [
      { scale: v.interpolate({ inputRange: [0, 1], outputRange: [0.5, 2.4] }) },
    ],
  });

  return (
    <View style={styles.radar}>
      {active && (
        <>
          <Animated.View
            style={[styles.ring, { borderColor: color }, ring(r1)]}
          />
          <Animated.View
            style={[styles.ring, { borderColor: color }, ring(r2)]}
          />
        </>
      )}
      <View style={[styles.core, { borderColor: color }]}>
        <MaterialCommunityIcons name="bluetooth" size={44} color={color} />
      </View>
    </View>
  );
}

function DeviceCard({
  device,
  onPress,
  disabled,
}: {
  device: ObdDevice;
  onPress?: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      testID={`device-card-${device.id}`}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [styles.deviceCard, pressed && styles.deviceCardPressed]}
    >
      <View style={styles.deviceIcon}>
        <MaterialCommunityIcons
          name="access-point"
          size={22}
          color={colors.brand}
        />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.deviceName} numberOfLines={1}>
          {device.name}
        </Text>
        <Text style={styles.deviceAddr}>{device.address}</Text>
      </View>
      {device.rssi != null && (
        <View style={styles.signal}>
          <MaterialCommunityIcons
            name="signal"
            size={16}
            color={colors.success}
          />
          <Text style={styles.signalText}>{device.rssi} dBm</Text>
        </View>
      )}
      {onPress && (
        <MaterialCommunityIcons
          name="chevron-right"
          size={22}
          color={colors.onSurfaceTertiary}
        />
      )}
    </Pressable>
  );
}

export default function ConnectScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { connect } = useObd();

  const [mode, setMode] = useState<OdbMode>("demo");
  const [phase, setPhase] = useState<Phase>("idle");
  const [devices, setDevices] = useState<ObdDevice[]>([]);
  const [connectingTo, setConnectingTo] = useState<ObdDevice | null>(null);
  const [errorKind, setErrorKind] = useState<ErrorKind | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [demoUnplugged, setDemoUnplugged] = useState(false);

  // Restore the last used mode; demo stays the default for development.
  useEffect(() => {
    loadMode().then(setMode);
  }, []);

  // Keep the demo transport's unplug simulation in sync with the switch.
  useEffect(() => {
    getDemoTransport().simulateUnplugged = demoUnplugged;
  }, [demoUnplugged]);

  const reset = useCallback(() => {
    setPhase("idle");
    setDevices([]);
    setConnectingTo(null);
    setErrorKind(null);
    setConnectError(null);
  }, []);

  const toggleMode = (demo: boolean) => {
    const next: OdbMode = demo ? "demo" : "real";
    setMode(next);
    saveMode(next);
    reset();
  };

  const startSearch = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setPhase("scanning");
    const transport = getTransport(mode);
    const activeMode = mode;
    try {
      const found = await transport.scanDevices();
      if (activeMode !== mode) return; // mode switched mid-scan
      if (found.length === 0) {
        setErrorKind("none-found");
        setPhase("error");
        return;
      }
      setDevices(found);
      setPhase("found");
    } catch (e) {
      if (activeMode !== mode) return;
      setErrorKind(e instanceof OdbScanError ? e.kind : "none-found");
      setPhase("error");
    }
  };

  const doConnect = async (device: ObdDevice) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setPhase("connecting");
    setConnectingTo(device);
    setConnectError(null);
    const transport = getTransport(mode);
    try {
      // Real transports verify the ELM327 handshake (ATZ + ATI) here;
      // demo mode just simulates the delay.
      await transport.connect(device);
    } catch (e) {
      transport.disconnect();
      // Back to the list with a plain message — the user picks another
      // device instead of restarting the whole search.
      setConnectError(
        e instanceof Error ? e.message : "Connection failed. Try another device.",
      );
      setPhase("found");
      setConnectingTo(null);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }
    // Identify the vehicle: mode 09 read (VIN/CALID/ECU name/protocol),
    // vPIC decode and consistency checks. Failing this step must not
    // block the connection — the dashboard shows the warnings instead.
    let identification: Identification | undefined;
    try {
      identification = await identifyVehicle(transport);
    } catch {
      // Defensive: connect() falls back to a generated vehicle.
    }
    connect(device, identification);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    router.replace("/(tabs)/dashboard");
  };

  const retry = reset;

  const statusColor = phase === "error" ? colors.error : colors.brand;

  const statusText = (): { title: string; sub: string } => {
    switch (phase) {
      case "scanning":
        return {
          title: "Searching for adapters…",
          sub: "Scanning nearby Bluetooth OBD-II devices.",
        };
      case "found":
        return {
          title:
            devices.length === 1 ? "Adapter found" : `${devices.length} adapters found`,
          sub: "Tap your adapter to connect and verify the ELM327 link.",
        };
      case "connecting":
        return {
          title: "Connecting…",
          sub: connectingTo
            ? `Linking with ${connectingTo.name} and verifying the ELM327 handshake.`
            : "Establishing a link with the OBD-II adapter.",
        };
      case "error":
        return { title: "Connection failed", sub: errorText(errorKind).sub };
      default:
        return {
          title: "Ready to connect",
          sub: "Plug the adapter into your car’s OBD-II port, turn on the ignition, then search.",
        };
    }
  };

  const { title, sub } = statusText();

  return (
    <View style={styles.root}>
      <Image
        source={{ uri: HERO }}
        style={StyleSheet.absoluteFill}
        contentFit="cover"
      />
      <LinearGradient
        colors={["rgba(5,5,5,0.35)", "rgba(5,5,5,0.85)", colors.surface]}
        locations={[0, 0.5, 1]}
        style={StyleSheet.absoluteFill}
      />

      <View
        style={[
          styles.content,
          { paddingTop: insets.top + spacing.lg, paddingBottom: insets.bottom + spacing.lg },
        ]}
      >
        <View style={styles.header}>
          <Logo size={30} />
          <Text style={styles.tagline}>OBD-II DIAGNOSTICS</Text>
        </View>

        <View style={styles.center}>
          <Radar
            active={phase === "scanning" || phase === "connecting"}
            color={statusColor}
          />
          <Text
            testID="connect-status-title"
            style={[styles.title, phase === "error" && { color: colors.error }]}
          >
            {title}
          </Text>
          <Text style={styles.sub}>{sub}</Text>

          {phase === "found" && (
            <View style={styles.deviceList}>
              {connectError ? (
                <Text style={styles.connectError} testID="connect-error">
                  {connectError}
                </Text>
              ) : null}
              {devices.map((device) => (
                <DeviceCard
                  key={device.id}
                  device={device}
                  onPress={() => doConnect(device)}
                />
              ))}
            </View>
          )}

          {phase === "connecting" && connectingTo && (
            <View style={styles.deviceList}>
              <DeviceCard device={connectingTo} disabled />
            </View>
          )}

          {phase === "error" && (
            <View testID="error-card" style={styles.errorCard}>
              <Text style={styles.errorHeading}>Troubleshooting</Text>
              {errorText(errorKind).tips.map((tip, i) => (
                <View key={i} style={styles.tipRow}>
                  <MaterialCommunityIcons
                    name="chevron-right"
                    size={18}
                    color={colors.error}
                  />
                  <Text style={styles.tipText}>{tip}</Text>
                </View>
              ))}
            </View>
          )}
        </View>

        <View style={styles.footer}>
          <View style={styles.demoRow}>
            <MaterialCommunityIcons
              name="flask-outline"
              size={16}
              color={colors.onSurfaceTertiary}
            />
            <Text style={styles.demoLabel}>Demo mode</Text>
            <Switch
              testID="demo-mode-switch"
              value={mode === "demo"}
              onValueChange={toggleMode}
              trackColor={{ false: colors.surfaceTertiary, true: colors.brand }}
              thumbColor={colors.onSurface}
            />
          </View>

          {mode === "demo" && (
            <View style={styles.demoRow}>
              <MaterialCommunityIcons
                name="flask-outline"
                size={16}
                color={colors.onSurfaceTertiary}
              />
              <Text style={styles.demoLabel}>Simulate adapter unplugged</Text>
              <Switch
                testID="demo-unplug-switch"
                value={demoUnplugged}
                onValueChange={setDemoUnplugged}
                trackColor={{ false: colors.surfaceTertiary, true: colors.error }}
                thumbColor={colors.onSurface}
              />
            </View>
          )}

          {phase === "idle" && (
            <NeonButton
              testID="search-button"
              label="Search for OBD device"
              icon="magnify"
              onPress={startSearch}
            />
          )}
          {phase === "scanning" && (
            <NeonButton
              testID="scanning-button"
              label="Searching…"
              loading
              onPress={() => {}}
            />
          )}
          {phase === "connecting" && (
            <NeonButton
              testID="connecting-button"
              label="Connecting…"
              loading
              onPress={() => {}}
            />
          )}
          {phase === "error" && (
            <NeonButton
              testID="retry-button"
              label="Retry"
              icon="refresh"
              onPress={retry}
            />
          )}
        </View>
      </View>
    </View>
  );
}

function errorText(kind: ErrorKind | null): { sub: string; tips: string[] } {
  switch (kind) {
    case "bluetooth-off":
      return {
        sub: "Bluetooth is turned off on your phone.",
        tips: ["Turn on Bluetooth in your phone settings, then retry."],
      };
    case "permission-denied":
      return {
        sub: "Bluetooth permission is required to find adapters.",
        tips: [
          "Allow “Nearby devices” (Android 12+) or location permission in system settings for this app.",
          "Retry the search after granting permission.",
        ],
      };
    case "unsupported":
      return {
        sub: "BLE scanning is not supported on this platform.",
        tips: ["Real adapters work on Android and iOS."],
      };
    case "handshake":
      return {
        sub: "None of the tried devices answered as an ELM327.",
        tips: [
          "Make sure the adapter is a BLE ELM327 (Vgate, vLinker, Viecar, KW902) — classic Bluetooth ELM327 adapters cannot work with this app.",
          "Turn the ignition ON so the adapter has power.",
          "Unplug and re-plug the adapter, then retry.",
        ],
      };
    case "disconnected":
      return {
        sub: "The adapter disconnected during connection.",
        tips: [
          "Keep the phone close to the adapter and retry.",
          "Re-plug the adapter into the OBD-II port.",
          "If Android asks for a pairing PIN, try 1234 or 0000.",
        ],
      };
    default:
      return {
        sub: "No OBD-II adapter detected.",
        tips: [
          "Re-plug the OBD-II adapter into the port.",
          "Make sure the ignition (or engine) is ON.",
          "Check that Bluetooth is enabled on your phone.",
          "Move closer to the adapter, then retry.",
        ],
      };
  }
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surface },
  content: { flex: 1, paddingHorizontal: spacing.lg },
  header: { alignItems: "center", gap: spacing.xs },
  tagline: {
    color: colors.brand,
    fontFamily: font.displayMed,
    fontSize: type.sm,
    letterSpacing: 3,
  },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  radar: {
    width: 180,
    height: 180,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.xl,
  },
  ring: {
    position: "absolute",
    width: 120,
    height: 120,
    borderRadius: 60,
    borderWidth: 2,
  },
  core: {
    width: 96,
    height: 96,
    borderRadius: 48,
    borderWidth: 2,
    backgroundColor: colors.surfaceSecondary,
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    color: colors.onSurface,
    fontFamily: font.display,
    fontSize: 26,
    textAlign: "center",
  },
  sub: {
    color: colors.onSurfaceTertiary,
    fontFamily: font.regular,
    fontSize: type.base,
    textAlign: "center",
    lineHeight: 20,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  deviceList: {
    width: "100%",
    gap: spacing.sm,
    marginTop: spacing.xl,
  },
  connectError: {
    color: colors.error,
    fontFamily: font.regular,
    fontSize: type.sm,
    textAlign: "center",
    lineHeight: 18,
  },
  deviceCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.brand,
    borderRadius: radius.md,
    padding: spacing.lg,
    width: "100%",
  },
  deviceCardPressed: { opacity: 0.65 },
  deviceIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.brandTertiary,
    alignItems: "center",
    justifyContent: "center",
  },
  deviceName: {
    color: colors.onSurface,
    fontFamily: font.semibold,
    fontSize: type.base,
    flexShrink: 1,
  },
  deviceAddr: {
    color: colors.onSurfaceTertiary,
    fontFamily: font.regular,
    fontSize: type.sm,
    marginTop: 2,
  },
  signal: { alignItems: "flex-end" },
  signalText: {
    color: colors.success,
    fontFamily: font.displayMed,
    fontSize: type.sm,
    marginTop: 2,
  },
  errorCard: {
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.error,
    borderRadius: radius.md,
    padding: spacing.lg,
    marginTop: spacing.xl,
    width: "100%",
    gap: spacing.sm,
  },
  errorHeading: {
    color: colors.error,
    fontFamily: font.displaySemi,
    fontSize: type.lg,
    letterSpacing: 0.5,
    marginBottom: spacing.xs,
  },
  tipRow: { flexDirection: "row", alignItems: "flex-start", gap: spacing.xs },
  tipText: {
    flex: 1,
    color: colors.onSurfaceSecondary,
    fontFamily: font.regular,
    fontSize: type.base,
    lineHeight: 20,
  },
  footer: { gap: spacing.md },
  demoRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    justifyContent: "center",
  },
  demoLabel: {
    color: colors.onSurfaceTertiary,
    fontFamily: font.regular,
    fontSize: type.sm,
  },
});
