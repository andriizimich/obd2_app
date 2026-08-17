import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import SystemChip from "@/src/components/SystemChip";
import { useToast } from "@/src/components/Toast";
import { deleteScan, getScan, type Scan } from "@/src/api/client";
import { colors, font, groupColor, radius, spacing, type } from "@/src/theme";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function ScanDetail() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const toast = useToast();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [scan, setScan] = useState<Scan | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const data = await getScan(id);
      setScan(data);
    } catch (e) {
      toast("Could not load scan", "error");
    } finally {
      setLoading(false);
    }
  }, [id, toast]);

  useEffect(() => {
    load();
  }, [load]);

  const onDelete = async () => {
    try {
      await deleteScan(id);
      toast("Scan deleted", "success");
      router.back();
    } catch (e) {
      toast("Failed to delete", "error");
    }
  };

  const ok = scan ? scan.fault_count === 0 : true;

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <Pressable
          testID="detail-back"
          onPress={() => router.back()}
          hitSlop={12}
          style={{ width: 26 }}
        >
          <MaterialCommunityIcons
            name="chevron-left"
            size={26}
            color={colors.onSurface}
          />
        </Pressable>
        <Text style={styles.headerTitle}>Scan Result</Text>
        <Pressable testID="delete-scan-button" onPress={onDelete} hitSlop={12}>
          <MaterialCommunityIcons
            name="trash-can-outline"
            size={22}
            color={colors.error}
          />
        </Pressable>
      </View>

      {loading || !scan ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.brand} />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={{
            padding: spacing.lg,
            paddingBottom: insets.bottom + spacing.xl,
            gap: spacing.md,
          }}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.vehicleCard}>
            <Text style={styles.carName}>
              {scan.vehicle.make} {scan.vehicle.model}
            </Text>
            <Text style={styles.carMeta}>
              {scan.vehicle.year} ·{" "}
              {scan.vehicle.mileage != null
                ? `${scan.vehicle.mileage.toLocaleString()} km`
                : "mileage —"}
            </Text>
            <View style={styles.vinRow}>
              <Text style={styles.vinLabel}>VIN</Text>
              <Text style={styles.vinValue}>{scan.vehicle.vin}</Text>
            </View>
            <Text style={styles.date}>{formatDate(scan.created_at)}</Text>
          </View>

          <View
            style={[
              styles.statusBanner,
              {
                borderColor: ok ? colors.success : colors.warning,
                backgroundColor: ok ? `${colors.success}14` : `${colors.warning}14`,
              },
            ]}
          >
            <MaterialCommunityIcons
              name={ok ? "check-circle" : "alert"}
              size={22}
              color={ok ? colors.success : colors.warning}
            />
            <Text
              style={[
                styles.statusText,
                { color: ok ? colors.success : colors.warning },
              ]}
            >
              {ok
                ? "No fault codes — all systems go"
                : `${scan.fault_count} fault code${scan.fault_count > 1 ? "s" : ""}`}
            </Text>
          </View>

          {scan.faults.map((f) => {
            const c = groupColor(f.group);
            return (
              <View key={f.code} style={styles.faultRow}>
                <View style={[styles.codeBox, { borderColor: c }]}>
                  <Text style={[styles.code, { color: c }]}>{f.code}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <SystemChip group={f.group} />
                  <Text style={styles.faultTitle}>{f.title}</Text>
                  <Text style={styles.faultDesc}>{f.description}</Text>
                </View>
              </View>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surface },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
  },
  headerTitle: {
    color: colors.onSurface,
    fontFamily: font.displaySemi,
    fontSize: type.xl,
    letterSpacing: 0.5,
  },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  vehicleCard: {
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.lg,
    gap: spacing.xs,
  },
  carName: {
    color: colors.onSurface,
    fontFamily: font.display,
    fontSize: 26,
  },
  carMeta: {
    color: colors.onSurfaceSecondary,
    fontFamily: font.regular,
    fontSize: type.base,
  },
  vinRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  vinLabel: {
    color: colors.brand,
    fontFamily: font.displayMed,
    fontSize: type.sm,
    letterSpacing: 1.5,
  },
  vinValue: {
    color: colors.onSurface,
    fontFamily: font.displaySemi,
    fontSize: type.base,
    letterSpacing: 1,
  },
  date: {
    color: colors.onSurfaceTertiary,
    fontFamily: font.regular,
    fontSize: type.sm,
    marginTop: spacing.xs,
  },
  statusBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.lg,
  },
  statusText: {
    fontFamily: font.displaySemi,
    fontSize: type.lg,
    letterSpacing: 0.5,
  },
  faultRow: {
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
  faultTitle: {
    color: colors.onSurface,
    fontFamily: font.semibold,
    fontSize: type.lg,
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
  },
  faultDesc: {
    color: colors.onSurfaceTertiary,
    fontFamily: font.regular,
    fontSize: type.base,
    lineHeight: 20,
  },
});
