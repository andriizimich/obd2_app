import { MaterialCommunityIcons } from "@expo/vector-icons";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { colors, font, radius, spacing, type } from "@/src/theme";

type ToastType = "success" | "error" | "info";
type ToastState = { message: string; type: ToastType } | null;

const ToastCtx = createContext<(message: string, type?: ToastType) => void>(
  () => {},
);

const ICON: Record<ToastType, keyof typeof MaterialCommunityIcons.glyphMap> = {
  success: "check-circle",
  error: "alert-circle",
  info: "information",
};
const ACCENT: Record<ToastType, string> = {
  success: colors.success,
  error: colors.error,
  info: colors.brand,
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  const [toast, setToast] = useState<ToastState>(null);
  const anim = useRef(new Animated.Value(0)).current;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback(
    (message: string, toastType: ToastType = "info") => {
      if (timer.current) clearTimeout(timer.current);
      setToast({ message, type: toastType });
    },
    [],
  );

  useEffect(() => {
    if (!toast) return;
    Animated.spring(anim, {
      toValue: 1,
      useNativeDriver: true,
      friction: 8,
      tension: 80,
    }).start();
    timer.current = setTimeout(() => {
      Animated.timing(anim, {
        toValue: 0,
        duration: 220,
        useNativeDriver: true,
      }).start(() => setToast(null));
    }, 2600);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [toast, anim]);

  return (
    <ToastCtx.Provider value={show}>
      {children}
      {toast && (
        <Animated.View
          testID="toast"
          pointerEvents="none"
          style={[
            styles.wrap,
            {
              top: insets.top + spacing.sm,
              opacity: anim,
              transform: [
                {
                  translateY: anim.interpolate({
                    inputRange: [0, 1],
                    outputRange: [-24, 0],
                  }),
                },
              ],
            },
          ]}
        >
          <View style={[styles.toast, { borderColor: ACCENT[toast.type] }]}>
            <MaterialCommunityIcons
              name={ICON[toast.type]}
              size={20}
              color={ACCENT[toast.type]}
            />
            <Text style={styles.text} numberOfLines={2}>
              {toast.message}
            </Text>
          </View>
        </Animated.View>
      )}
    </ToastCtx.Provider>
  );
}

export function useToast() {
  return useContext(ToastCtx);
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    left: spacing.lg,
    right: spacing.lg,
    zIndex: 9999,
    elevation: 9999,
  },
  toast: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  text: {
    flex: 1,
    color: colors.onSurface,
    fontFamily: font.medium,
    fontSize: type.base,
  },
});
