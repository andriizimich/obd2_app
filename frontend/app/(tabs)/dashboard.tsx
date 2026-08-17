import { MaterialCommunityIcons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { Image } from "expo-image";
import { Redirect, useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import IdEvidence from "@/src/components/IdEvidence";
import Logo from "@/src/components/Logo";
import NeonButton from "@/src/components/NeonButton";
import VinCheck from "@/src/components/VinCheck";
import { useObd } from "@/src/context/ObdContext";
import { colors, font, radius, spacing, type } from "@/src/theme";

const CAR =
  "https://images.unsplash.com/photo-1580014317999-e9f1936787a5?crop=entropy&cs=srgb&fm=jpg&ixid=M3w4NjAzNTl8MHwxfHNlYXJjaHwxfHxzcG9ydHMlMjBjYXIlMjBkYXJrJTIwYmFja2dyb3VuZHxlbnwwfHx8fDE3ODYyOTI4NTZ8MA&ixlib=rb-4.1.0&q=85";

function StatCell({
  icon,
  label,
  value,
  mono,
  testID,
}: {
  icon: keyof typeof MaterialCommunityIcons.glyphMap;
  label: string;
  value: string;
  mono?: boolean;
  testID?: string;
}) {
  return (
    <View style={styles.cell} testID={testID}>
      <View style={styles.cellHead}>
        <MaterialCommunityIcons
          name={icon}
          size={15}
          color={colors.onSurfaceTertiary}
        />
        <Text style={styles.cellLabel}>{label}</Text>
      </View>
      <Text
        style={[styles.cellValue, mono && { fontFamily: font.displaySemi }]}
        numberOfLines={1}
        adjustsFontSizeToFit
      >
        {value}
      </Text>
    </View>
  );
}

export default function Dashboard() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { vehicle, device, evidence, runScan, disconnect } = useObd();

  if (!vehicle) return <Redirect href="/" />;

  const onScan = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    router.push("/fault-codes");
  };

  const onDisconnect = () => {
    disconnect();
    router.replace("/");
  };

  return (
    <View style={styles.root}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: 140 }}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.hero}>
          <Image source={{ uri: CAR }} style={StyleSheet.absoluteFill} contentFit="cover" />
          <LinearGradient
            colors={["rgba(5,5,5,0.2)", "rgba(5,5,5,0.75)", colors.surface]}
            locations={[0, 0.6, 1]}
            style={StyleSheet.absoluteFill}
          />
          <View style={[styles.heroTop, { paddingTop: insets.top + spacing.md }]}>
            <Logo size={26} />
            <Pressable
              testID="disconnect-button"
              onPress={onDisconnect}
              style={styles.disconnect}
              hitSlop={10}
            >
              <MaterialCommunityIcons
                name="bluetooth-off"
                size={16}
                color={colors.onSurfaceTertiary}
              />
              <Text style={styles.disconnectText}>Disconnect</Text>
            </Pressable>
          </View>

          <View style={styles.heroInfo}>
            <View style={styles.connectedPill}>
              <View style={styles.liveDot} />
              <Text style={styles.connectedText}>
                {device?.name ?? "OBD-II adapter"}
              </Text>
            </View>
            <Text style={styles.carName} testID="vehicle-name">
              {vehicle.make}
            </Text>
            <Text style={styles.carModel}>
              {vehicle.model
                ? `${vehicle.model} · ${vehicle.year}`
                : "Vehicle not identified"}
            </Text>
          </View>
        </View>

        <View style={styles.body}>
          <Text style={styles.sectionTitle}>Vehicle Information</Text>

          <View style={styles.vinCard} testID="vin-card">
            <Text style={styles.vinLabel}>VIN</Text>
            <Text style={styles.vinValue} numberOfLines={1} adjustsFontSizeToFit>
              {vehicle.vin}
            </Text>
            <VinCheck
              vin={vehicle.vin}
              expected={{ make: vehicle.make, model: vehicle.model, year: vehicle.year }}
            />
          </View>

          <View style={styles.grid}>
            <StatCell
              testID="stat-make"
              icon="car-side"
              label="MAKE"
              value={vehicle.make}
            />
            <StatCell
              testID="stat-model"
              icon="car-sports"
              label="MODEL"
              value={vehicle.model}
            />
            <StatCell
              testID="stat-year"
              icon="calendar"
              label="YEAR"
              value={String(vehicle.year)}
              mono
            />
            <StatCell
              testID="stat-mileage"
              icon="speedometer"
              label="MILEAGE"
              value={vehicle.mileage != null ? `${vehicle.mileage.toLocaleString()} km` : "—"}
              mono
            />
            {vehicle.engineModel ? (
              <StatCell
                testID="stat-engine"
                icon="engine"
                label="ENGINE"
                value={vehicle.engineModel}
              />
            ) : null}
          </View>

          {evidence ? <IdEvidence evidence={evidence} /> : null}
        </View>
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.md }]}>
        <NeonButton
          testID="scan-car-button"
          label="Scan Car"
          icon="radar"
          onPress={onScan}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surface },
  hero: { height: 340, justifyContent: "space-between" },
  heroTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: spacing.lg,
  },
  disconnect: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    backgroundColor: "rgba(18,18,20,0.7)",
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.pill,
  },
  disconnectText: {
    color: colors.onSurfaceTertiary,
    fontFamily: font.medium,
    fontSize: type.sm,
  },
  heroInfo: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg },
  connectedPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    alignSelf: "flex-start",
    backgroundColor: colors.brandTertiary,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 5,
    marginBottom: spacing.md,
  },
  liveDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: colors.success,
  },
  connectedText: {
    color: colors.brand,
    fontFamily: font.medium,
    fontSize: type.sm,
  },
  carName: {
    color: colors.onSurface,
    fontFamily: font.display,
    fontSize: 40,
    letterSpacing: 0.5,
  },
  carModel: {
    color: colors.onSurfaceSecondary,
    fontFamily: font.regular,
    fontSize: type.lg,
    marginTop: -4,
  },
  body: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg, gap: spacing.md },
  sectionTitle: {
    color: colors.onSurfaceTertiary,
    fontFamily: font.displaySemi,
    fontSize: type.base,
    letterSpacing: 2,
    textTransform: "uppercase",
  },
  vinCard: {
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.lg,
  },
  vinLabel: {
    color: colors.brand,
    fontFamily: font.displayMed,
    fontSize: type.sm,
    letterSpacing: 2,
    marginBottom: spacing.xs,
  },
  vinValue: {
    color: colors.onSurface,
    fontFamily: font.displaySemi,
    fontSize: 22,
    letterSpacing: 1.5,
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.md,
  },
  cell: {
    flexGrow: 1,
    flexBasis: "46%",
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  cellHead: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  cellLabel: {
    color: colors.onSurfaceTertiary,
    fontFamily: font.medium,
    fontSize: type.sm,
    letterSpacing: 1,
  },
  cellValue: {
    color: colors.onSurface,
    fontFamily: font.semibold,
    fontSize: type.xl,
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
