import React from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import { useVinDecode } from "@/src/hooks/use-vin-decode";
import { colors, font, radius, spacing, type } from "@/src/theme";
import { modelYearsForChar, validateVin, vinRegion, wmiManufacturer } from "@/src/utils/vin";

type Props = {
  vin: string;
  expected: { make: string; model: string; year: number };
};

type Confidence = "high" | "medium" | "low" | "unknown";

const CONFIDENCE_META: Record<Confidence, { color: string; label: string }> = {
  high: { color: colors.success, label: "High confidence · full decode" },
  medium: { color: colors.brand, label: "Medium confidence · basic identity" },
  low: { color: colors.warning, label: "Low confidence · partial data" },
  unknown: { color: colors.onSurfaceTertiary, label: "Unconfirmed" },
};

function ConfidenceLabel({ confidence }: { confidence: Confidence }) {
  const meta = CONFIDENCE_META[confidence];
  return (
    <View style={styles.confidenceRow} testID="vin-decode-confidence">
      <View style={[styles.confidenceDot, { backgroundColor: meta.color }]} />
      <Text style={[styles.detailText, { color: meta.color }]}>{meta.label}</Text>
    </View>
  );
}

export default function VinCheck({ vin, expected }: Props) {
  const check = validateVin(vin);
  const { state, retry } = useVinDecode(vin);

  const region = vinRegion(vin[0] ?? "");
  const wmiMake = wmiManufacturer(vin);
  const yearChar = vin[9] ?? "";
  const possibleYears = modelYearsForChar(yearChar);

  const pillColor = check.valid ? colors.success : colors.error;

  return (
    <View style={styles.root} testID="vin-check">
      {/* Row 1 — local validation status */}
      <View style={[styles.pill, { borderColor: pillColor, backgroundColor: `${pillColor}1A` }]} testID="vin-check-status">
        <View style={[styles.dot, { backgroundColor: pillColor }]} />
        <Text style={[styles.pillText, { color: pillColor }]} numberOfLines={1} adjustsFontSizeToFit>
          {check.valid
            ? `Valid VIN · ${region} · ${wmiMake ?? "Unknown WMI"} · Check digit verified`
            : "Invalid VIN"}
        </Text>
      </View>

      {!check.valid && (
        <Text style={styles.reason} testID="vin-check-reason">
          {check.reasons.join("\n")}
        </Text>
      )}

      {possibleYears.length > 0 && (
        <Text style={styles.yearLine}>
          Model year char "{yearChar}" (pos 10) → {possibleYears.join(" or ")} (30-year cycle)
        </Text>
      )}

      {/* Row 2 — NHTSA decode */}
      <View style={styles.detailCard} testID="vin-check-detail">
        {state.status === "loading" && (
          <View style={styles.loadingRow} testID="vin-decode-loading">
            <ActivityIndicator size="small" color={colors.brand} />
            <Text style={styles.detailText}>Checking NHTSA database…</Text>
          </View>
        )}

        {state.status === "error" && (
          <View testID="vin-decode-error">
            <Text style={[styles.detailTitle, { color: colors.warning }]}>NHTSA lookup unavailable</Text>
            <Text style={styles.detailText}>{state.message}</Text>
            <Pressable onPress={retry} hitSlop={8} style={styles.retryButton} testID="vin-decode-retry">
              <Text style={styles.retryText}>Retry</Text>
            </Pressable>
          </View>
        )}

        {state.status === "ready" && state.result.status === "ok" && (
          <View>
            <Text style={[styles.detailTitle, { color: colors.success }]} testID="vin-decoded-make">
              Decoded by NHTSA: {state.result.make} {state.result.model && `${state.result.model} · `}
              {state.result.year && state.result.year}
            </Text>
            <ConfidenceLabel confidence={state.result.confidence} />
            {state.result.engineModel || state.result.engineCylinders ? (
              <Text style={styles.detailText}>
                Engine: {state.result.engineModel}
                {state.result.engineCylinders ? ` · ${state.result.engineCylinders}-cylinder` : ""}
              </Text>
            ) : null}
            {state.result.fuelType ? (
              <Text style={styles.detailText}>Fuel: {state.result.fuelType}</Text>
            ) : null}
            {state.result.transmission ? (
              <Text style={styles.detailText}>Transmission: {state.result.transmission}</Text>
            ) : null}
            {state.result.driveType ? (
              <Text style={styles.detailText}>Drive: {state.result.driveType}</Text>
            ) : null}
            {state.result.plantCountry ? (
              <Text style={styles.detailText}>Plant: {state.result.plantCountry}</Text>
            ) : null}
            <Text
              style={[
                styles.detailText,
                {
                  color:
                    state.result.make.trim().toUpperCase() === expected.make.trim().toUpperCase()
                      ? colors.success
                      : colors.warning,
                },
              ]}
            >
              {state.result.make.trim().toUpperCase() === expected.make.trim().toUpperCase()
                ? `Matches vehicle info: ${expected.make}`
                : `Make differs from vehicle info: expected ${expected.make}`}
            </Text>
          </View>
        )}

        {state.status === "ready" && state.result.status === "partial" && (
          <View>
            <Text style={[styles.detailTitle, { color: colors.warning }]}>
              VIN format recognized, but not found in NHTSA database
            </Text>
            <ConfidenceLabel confidence={state.result.confidence} />
            {state.result.make ? (
              <Text style={styles.detailText} testID="vin-decoded-make">
                WMI-decoded make: {state.result.make}
              </Text>
            ) : null}
            {state.result.year ? (
              <Text style={styles.detailText} testID="vin-decoded-year">
                Reported year: {state.result.year}
              </Text>
            ) : null}
            <Text style={styles.errorText} numberOfLines={2}>
              {state.result.errorText}
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: spacing.sm, marginTop: spacing.sm },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    alignSelf: "flex-start",
    maxWidth: "100%",
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
  pillText: {
    fontFamily: font.semibold,
    fontSize: type.sm,
    letterSpacing: 0.3,
    flexShrink: 1,
  },
  reason: {
    color: colors.error,
    fontFamily: font.regular,
    fontSize: type.sm,
    lineHeight: 18,
  },
  yearLine: {
    color: colors.onSurfaceTertiary,
    fontFamily: font.regular,
    fontSize: type.sm,
  },
  detailCard: {
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.xs,
  },
  loadingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  detailTitle: {
    fontFamily: font.semibold,
    fontSize: type.sm,
  },
  detailText: {
    color: colors.onSurfaceSecondary,
    fontFamily: font.regular,
    fontSize: type.sm,
    lineHeight: 18,
  },
  confidenceRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  confidenceDot: { width: 6, height: 6, borderRadius: 3 },
  errorText: {
    color: colors.onSurfaceTertiary,
    fontFamily: font.regular,
    fontSize: type.sm,
    lineHeight: 16,
  },
  retryButton: {
    alignSelf: "flex-start",
    borderWidth: 1,
    borderColor: colors.brand,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    marginTop: spacing.xs,
  },
  retryText: {
    color: colors.brand,
    fontFamily: font.semibold,
    fontSize: type.sm,
  },
});
