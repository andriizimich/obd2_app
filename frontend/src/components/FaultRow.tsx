import { MaterialCommunityIcons } from "@expo/vector-icons";
import React, { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import SystemChip from "@/src/components/SystemChip";
import type { DtcStatus, Fault } from "@/src/obd/types";
import { colors, font, groupColor, radius, spacing, type } from "@/src/theme";

const SEVERITY_COLOR: Record<string, string> = {
  high: colors.error,
  medium: colors.warning,
  low: colors.onSurfaceTertiary,
};

/** Only the two lists that are not the default get a badge — "stored" is
 *  what a code is assumed to be, so labelling it would be noise. */
const STATUS_LABEL: Partial<Record<DtcStatus, string>> = {
  pending: "PENDING",
  permanent: "PERMANENT",
};

/**
 * One fault code. Shared by the results screen and a saved scan so the two
 * cannot drift apart — they were separate copies of the same layout before.
 *
 * Two things are drawn as estimates rather than facts, and they look it:
 * severity is our guess from the code's shape (no ECU reports severity),
 * and `known: false` says the title came from the code's own bytes rather
 * than a dictionary entry for it.
 */
export default function FaultRow({ fault }: { fault: Fault }) {
  const [showCauses, setShowCauses] = useState(false);
  const c = groupColor(fault.group);
  const sevColor = SEVERITY_COLOR[fault.severity] ?? colors.onSurfaceTertiary;
  const status = fault.status ? STATUS_LABEL[fault.status] : undefined;
  const causes = fault.causes ?? [];

  return (
    <View testID={`fault-row-${fault.code}`} style={styles.row}>
      <View style={[styles.codeBox, { borderColor: c }]}>
        <Text style={[styles.code, { color: c }]}>{fault.code}</Text>
      </View>

      <View style={styles.body}>
        <View style={styles.head}>
          <SystemChip group={fault.group} />
          <View style={styles.tags}>
            {status && (
              <View style={[styles.tag, { borderColor: colors.warning }]}>
                <Text style={[styles.tagText, { color: colors.warning }]}>
                  {status}
                </Text>
              </View>
            )}
            {fault.module && (
              <View style={[styles.tag, { borderColor: colors.border }]}>
                <Text style={[styles.tagText, { color: colors.onSurfaceTertiary }]}>
                  {fault.module.toUpperCase()}
                </Text>
              </View>
            )}
            <View style={styles.severity}>
              {/* An outlined dot: the severity is inferred from the code, the
                  car never said it. A filled dot would read as a measurement. */}
              <View style={[styles.sevDot, { borderColor: sevColor }]} />
              <Text style={[styles.sevText, { color: sevColor }]}>
                {fault.severity}
              </Text>
            </View>
          </View>
        </View>

        <Text style={styles.title}>{fault.title}</Text>
        <Text style={styles.desc}>{fault.description}</Text>

        {/* No separate "unknown code" marker: for a code the dictionary does
            not hold, `description` already says so in the line above, and
            repeating it twice per row is noise. */}

        {causes.length > 0 && (
          <>
            <Pressable
              testID={`fault-causes-toggle-${fault.code}`}
              onPress={() => setShowCauses((v) => !v)}
              hitSlop={6}
              style={styles.causesToggle}
            >
              <MaterialCommunityIcons
                name={showCauses ? "chevron-down" : "chevron-right"}
                size={16}
                color={colors.brand}
              />
              <Text style={styles.causesToggleText}>Typical causes</Text>
            </Pressable>
            {showCauses && (
              <View style={styles.causes} testID={`fault-causes-${fault.code}`}>
                {causes.map((cause) => (
                  <View key={cause} style={styles.causeRow}>
                    <Text style={styles.bullet}>•</Text>
                    <Text style={styles.causeText}>{cause}</Text>
                  </View>
                ))}
              </View>
            )}
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
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
  body: { flex: 1 },
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: spacing.xs,
    marginBottom: spacing.sm,
  },
  tags: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: spacing.xs,
  },
  tag: {
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.xs,
    paddingVertical: 1,
  },
  tagText: {
    fontFamily: font.semibold,
    fontSize: 10,
    letterSpacing: 0.5,
  },
  severity: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  sevDot: { width: 7, height: 7, borderRadius: 4, borderWidth: 1.5 },
  sevText: {
    fontFamily: font.semibold,
    fontSize: type.sm,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  title: {
    color: colors.onSurface,
    fontFamily: font.semibold,
    fontSize: type.lg,
    marginBottom: spacing.xs,
  },
  desc: {
    color: colors.onSurfaceTertiary,
    fontFamily: font.regular,
    fontSize: type.base,
    lineHeight: 20,
  },
  causesToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    marginTop: spacing.sm,
  },
  causesToggleText: {
    color: colors.brand,
    fontFamily: font.medium,
    fontSize: type.sm,
  },
  causes: { marginTop: spacing.sm, gap: spacing.xs },
  causeRow: { flexDirection: "row", gap: spacing.xs },
  bullet: { color: colors.onSurfaceTertiary, fontFamily: font.regular, fontSize: type.sm },
  causeText: {
    flex: 1,
    color: colors.onSurfaceSecondary,
    fontFamily: font.regular,
    fontSize: type.sm,
    lineHeight: 18,
  },
});
