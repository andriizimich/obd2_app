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
  Platform,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import Logo from "@/src/components/Logo";
import NeonButton from "@/src/components/NeonButton";
import { DEMO_DEVICES } from "@/src/demo/obd";
import { useObd } from "@/src/context/ObdContext";
import { colors, font, radius, spacing, type } from "@/src/theme";

const HERO =
  "https://images.unsplash.com/photo-1627819098699-d8ae75db1112?crop=entropy&cs=srgb&fm=jpg&ixid=M3w4NjA1NTN8MHwxfHNlYXJjaHwxfHxhYnN0cmFjdCUyMG5lb24lMjBibHVlJTIwbGlnaHQlMjBzdHJlYWtzJTIwYmxhY2slMjBiYWNrZ3JvdW5kfGVufDB8fHx8MTc4NjI5Mjg1MXww&ixlib=rb-4.1.0&q=85";

type Phase = "idle" | "scanning" | "found" | "connecting" | "error";

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

export default function ConnectScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { connect } = useObd();

  const [phase, setPhase] = useState<Phase>("idle");
  const [devicePluggedIn, setDevicePluggedIn] = useState(true);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(
    () => () => timers.current.forEach(clearTimeout),
    [],
  );

  const device = DEMO_DEVICES[0];

  const startSearch = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setPhase("scanning");
    const t = setTimeout(() => {
      if (devicePluggedIn) {
        setPhase("found");
      } else {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        setPhase("error");
      }
    }, 2200);
    timers.current.push(t);
  };

  const doConnect = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setPhase("connecting");
    const t = setTimeout(() => {
      if (!devicePluggedIn) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        setPhase("error");
        return;
      }
      connect(device);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.replace("/(tabs)/dashboard");
    }, 1400);
    timers.current.push(t);
  };

  const retry = () => setPhase("idle");

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
          title: "Adapter found",
          sub: "Tap connect to link with your vehicle’s ECU.",
        };
      case "connecting":
        return {
          title: "Connecting…",
          sub: "Establishing a link with the OBD-II adapter.",
        };
      case "error":
        return {
          title: "Connection failed",
          sub: "No OBD-II adapter detected.",
        };
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
            <View testID="device-card" style={styles.deviceCard}>
              <View style={styles.deviceIcon}>
                <MaterialCommunityIcons
                  name="access-point"
                  size={22}
                  color={colors.brand}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.deviceName}>{device.name}</Text>
                <Text style={styles.deviceAddr}>{device.address}</Text>
              </View>
              <View style={styles.signal}>
                <MaterialCommunityIcons
                  name="signal"
                  size={16}
                  color={colors.success}
                />
                <Text style={styles.signalText}>{device.rssi} dBm</Text>
              </View>
            </View>
          )}

          {phase === "error" && (
            <View testID="error-card" style={styles.errorCard}>
              <Text style={styles.errorHeading}>Troubleshooting</Text>
              {[
                "Re-plug the OBD-II adapter into the port.",
                "Make sure the ignition (or engine) is ON.",
                "Check that Bluetooth is enabled on your phone.",
                "Move closer to the adapter, then retry.",
              ].map((tip, i) => (
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
            <Text style={styles.demoLabel}>Simulate adapter unplugged</Text>
            <Switch
              testID="demo-unplug-switch"
              value={!devicePluggedIn}
              onValueChange={(v) => setDevicePluggedIn(!v)}
              trackColor={{ false: colors.surfaceTertiary, true: colors.error }}
              thumbColor={colors.onSurface}
            />
          </View>

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
          {phase === "found" && (
            <NeonButton
              testID="connect-button"
              label="Connect"
              icon="bluetooth-connect"
              onPress={doConnect}
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
  deviceCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.brand,
    borderRadius: radius.md,
    padding: spacing.lg,
    marginTop: spacing.xl,
    width: "100%",
  },
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
