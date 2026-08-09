import { MaterialCommunityIcons } from "@expo/vector-icons";
import React from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  ViewStyle,
} from "react-native";

import { colors, font, radius, spacing, type } from "@/src/theme";

type Props = {
  label: string;
  onPress: () => void;
  testID?: string;
  variant?: "primary" | "secondary" | "ghost";
  icon?: keyof typeof MaterialCommunityIcons.glyphMap;
  loading?: boolean;
  disabled?: boolean;
  style?: ViewStyle;
};

export default function NeonButton({
  label,
  onPress,
  testID,
  variant = "primary",
  icon,
  loading = false,
  disabled = false,
  style,
}: Props) {
  const isPrimary = variant === "primary";
  const isGhost = variant === "ghost";
  const fg = isPrimary
    ? colors.onBrand
    : isGhost
      ? colors.onSurfaceTertiary
      : colors.brand;

  const inactive = disabled || loading;

  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={inactive}
      style={({ pressed }) => [
        styles.base,
        isPrimary && styles.primary,
        variant === "secondary" && styles.secondary,
        isGhost && styles.ghost,
        pressed && !inactive && styles.pressed,
        inactive && styles.disabled,
        style,
      ]}
    >
      <View style={styles.inner}>
        {loading ? (
          <ActivityIndicator color={fg} />
        ) : (
          <>
            {icon && (
              <MaterialCommunityIcons name={icon} size={20} color={fg} />
            )}
            <Text style={[styles.label, { color: fg }]}>{label}</Text>
          </>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    height: 56,
    borderRadius: radius.md,
    justifyContent: "center",
    alignItems: "center",
  },
  primary: {
    backgroundColor: colors.brand,
  },
  secondary: {
    backgroundColor: colors.surfaceTertiary,
    borderWidth: 1,
    borderColor: colors.brand,
  },
  ghost: {
    backgroundColor: "transparent",
  },
  pressed: { opacity: 0.85, transform: [{ scale: 0.99 }] },
  disabled: { opacity: 0.45 },
  inner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  label: {
    fontFamily: font.displaySemi,
    fontSize: type.lg,
    letterSpacing: 0.5,
  },
});
