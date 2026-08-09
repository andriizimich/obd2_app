import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import React, { useCallback, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { listScans, type Scan } from "@/src/api/client";
import { colors, font, radius, spacing, type } from "@/src/theme";

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function Row({ scan, onPress }: { scan: Scan; onPress: () => void }) {
  const ok = scan.fault_count === 0;
  return (
    <Pressable
      testID={`history-row-${scan.id}`}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}
    >
      <View
        style={[
          styles.rowIcon,
          { borderColor: ok ? colors.success : colors.warning },
        ]}
      >
        <MaterialCommunityIcons
          name={ok ? "check-bold" : "alert"}
          size={20}
          color={ok ? colors.success : colors.warning}
        />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {scan.vehicle.make} {scan.vehicle.model}
        </Text>
        <Text style={styles.rowSub}>{formatDate(scan.created_at)}</Text>
      </View>
      <View style={styles.rowRight}>
        <View
          style={[
            styles.badge,
            {
              backgroundColor: ok ? `${colors.success}1A` : `${colors.warning}1A`,
              borderColor: ok ? colors.success : colors.warning,
            },
          ]}
        >
          <Text
            style={[
              styles.badgeText,
              { color: ok ? colors.success : colors.warning },
            ]}
          >
            {ok ? "OK" : `${scan.fault_count} DTC`}
          </Text>
        </View>
        <MaterialCommunityIcons
          name="chevron-right"
          size={22}
          color={colors.onSurfaceTertiary}
        />
      </View>
    </Pressable>
  );
}

export default function History() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [scans, setScans] = useState<Scan[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await listScans();
      setScans(data);
    } catch (e) {
      // silent — empty state will show
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.md }]}>
        <Text style={styles.title}>Scan History</Text>
        <Text style={styles.subtitle}>Saved diagnostic results</Text>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.brand} />
        </View>
      ) : (
        <FlatList
          data={scans}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{
            paddingHorizontal: spacing.lg,
            paddingBottom: insets.bottom + spacing.xl,
            flexGrow: 1,
          }}
          ItemSeparatorComponent={() => <View style={styles.sep} />}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                load();
              }}
              tintColor={colors.brand}
            />
          }
          renderItem={({ item }) => (
            <Row scan={item} onPress={() => router.push(`/scan/${item.id}`)} />
          )}
          ListEmptyComponent={
            <View style={styles.empty} testID="history-empty">
              <MaterialCommunityIcons
                name="clipboard-text-clock-outline"
                size={56}
                color={colors.onSurfaceTertiary}
              />
              <Text style={styles.emptyTitle}>No scans yet</Text>
              <Text style={styles.emptySub}>
                Your diagnostic history will appear here after you scan a
                vehicle.
              </Text>
            </View>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surface },
  header: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
  },
  title: {
    color: colors.onSurface,
    fontFamily: font.display,
    fontSize: 30,
    letterSpacing: 0.5,
  },
  subtitle: {
    color: colors.onSurfaceTertiary,
    fontFamily: font.regular,
    fontSize: type.base,
    marginTop: 2,
  },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  sep: { height: 1, backgroundColor: colors.divider },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: spacing.lg,
  },
  rowIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
  rowTitle: {
    color: colors.onSurface,
    fontFamily: font.semibold,
    fontSize: type.lg,
  },
  rowSub: {
    color: colors.onSurfaceTertiary,
    fontFamily: font.regular,
    fontSize: type.sm,
    marginTop: 2,
  },
  rowRight: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  badge: {
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
  },
  badgeText: {
    fontFamily: font.displaySemi,
    fontSize: type.sm,
    letterSpacing: 0.5,
  },
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    paddingTop: spacing["3xl"],
    paddingHorizontal: spacing.xl,
  },
  emptyTitle: {
    color: colors.onSurface,
    fontFamily: font.displaySemi,
    fontSize: type.xl,
    marginTop: spacing.sm,
  },
  emptySub: {
    color: colors.onSurfaceTertiary,
    fontFamily: font.regular,
    fontSize: type.base,
    textAlign: "center",
    lineHeight: 22,
  },
});
