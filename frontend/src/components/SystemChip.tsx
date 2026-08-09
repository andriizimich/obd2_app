import React from "react";
import { StyleSheet, Text, View } from "react-native";

import { GROUP_LABELS } from "@/src/demo/obd";
import { colors, font, groupColor, radius, spacing, type } from "@/src/theme";

export default function SystemChip({ group }: { group: string }) {
  const c = groupColor(group);
  const label = GROUP_LABELS[group.toLowerCase()] ?? group;
  return (
    <View
      testID={`system-chip-${group}`}
      style={[styles.chip, { borderColor: c, backgroundColor: `${c}22` }]}
    >
      <View style={[styles.dot, { backgroundColor: c }]} />
      <Text style={[styles.label, { color: c }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    alignSelf: "flex-start",
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
  label: {
    fontFamily: font.semibold,
    fontSize: type.sm,
    letterSpacing: 0.3,
  },
});
