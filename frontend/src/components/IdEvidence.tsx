import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";

import type { IdentificationEvidence } from "@/src/obd/types";
import { colors, font, radius, spacing, type } from "@/src/theme";

// Compact summary of how the vehicle was identified — the basis of the
// validation score. Shows the evidence sources (protocol, CALID, ECU name)
// and every consistency warning the pipeline produced.

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.value} numberOfLines={2}>
        {value || "—"}
      </Text>
    </View>
  );
}

export default function IdEvidence({ evidence }: { evidence: IdentificationEvidence }) {
  return (
    <View style={styles.card} testID="id-evidence">
      <View style={styles.header}>
        <MaterialCommunityIcons
          name={evidence.source === "ecu" ? "car-cog" : "flask-outline"}
          size={16}
          color={evidence.source === "ecu" ? colors.success : colors.brand}
        />
        <Text style={styles.title}>Identification evidence</Text>
      </View>

      <Row
        label="Source"
        value={evidence.source === "ecu" ? "Read from ECU (adapter)" : "Demo simulation"}
      />
      <Row label="Protocol" value={evidence.protocol ?? ""} />
      <Row label="CALID" value={evidence.calid.join(", ") || ""} />
      <Row label="ECU" value={evidence.ecuName ?? ""} />

      {evidence.warnings.map((warning, i) => (
        <View key={i} style={styles.warningRow}>
          <MaterialCommunityIcons
            name="alert-circle-outline"
            size={14}
            color={colors.warning}
          />
          <Text style={styles.warningText}>{warning}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.xs,
    marginTop: spacing.md,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    marginBottom: spacing.xs,
  },
  title: {
    color: colors.onSurface,
    fontFamily: font.semibold,
    fontSize: type.sm,
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: spacing.md,
  },
  label: {
    color: colors.onSurfaceTertiary,
    fontFamily: font.regular,
    fontSize: type.sm,
  },
  value: {
    flex: 1,
    color: colors.onSurfaceSecondary,
    fontFamily: font.regular,
    fontSize: type.sm,
    textAlign: "right",
  },
  warningRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.xs,
    marginTop: 2,
  },
  warningText: {
    flex: 1,
    color: colors.warning,
    fontFamily: font.regular,
    fontSize: type.sm,
    lineHeight: 18,
  },
});
