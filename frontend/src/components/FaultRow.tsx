import { MaterialCommunityIcons } from "@expo/vector-icons";
import React, { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import SystemChip from "@/src/components/SystemChip";
import type { DtcStatus, Fault } from "@/src/obd/types";
import { colors, font, groupColor, radius, spacing, type } from "@/src/theme";

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
 * What the ECU actually said is a code, a list and a module; the title and
 * description behind the code come from the bundled dictionary, and
 * `known: false` says there was no entry for it rather than that the code is
 * harmless. Severity used to be drawn here too — our guess from the code's
 * shape, which no ECU reports — and it went: a badge a driver reads as a
 * measurement has to be one.
 */
export default function FaultRow({ fault }: { fault: Fault }) {
  const [showCauses, setShowCauses] = useState(false);
  const c = groupColor(fault.group);
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
