import React from "react";
import { StyleSheet, Text, View } from "react-native";

import { colors, font, type } from "@/src/theme";

export default function Logo({ size = 28 }: { size?: number }) {
  const badge = size;
  return (
    <View style={styles.row} testID="brand-logo">
      <View
        style={[
          styles.badge,
          { width: badge, height: badge, borderRadius: badge / 2 },
        ]}
      >
        <Text style={[styles.r, { fontSize: size * 0.62 }]}>r</Text>
      </View>
      <Text style={[styles.word, { fontSize: size * 0.86 }]}>radacini</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  badge: {
    backgroundColor: colors.onSurface,
    justifyContent: "center",
    alignItems: "center",
  },
  r: {
    color: colors.surface,
    fontFamily: font.display,
    lineHeight: undefined,
    marginTop: -2,
  },
  word: {
    color: colors.onSurface,
    fontFamily: font.displaySemi,
    letterSpacing: 0.3,
  },
});
