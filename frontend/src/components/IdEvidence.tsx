import React from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";

import { BUILD_STAMP } from "@/src/build";
import type { Coverage, IdentificationEvidence } from "@/src/obd/types";
import { colors, font, radius, spacing, type } from "@/src/theme";

const READ_MARK: Record<Coverage["status"], string> = {
  ok: "✓",
  empty: "✓",
  unsupported: "✗",
  error: "✗",
  skipped: "–",
};

/** What to print when a read carries no detail of its own. Only `ok` can. */
const READ_LABEL: Record<Coverage["status"], string> = {
  ok: "read",
  empty: "read",
  unsupported: "not supported",
  error: "failed",
  skipped: "skipped",
};

// Compact summary of how the vehicle was identified — the basis of the
// validation score. Shows what the ECU answered (protocol, CALID, ECU name)
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
        <MaterialCommunityIcons name="car-cog" size={16} color={colors.success} />
        <Text style={styles.title}>Identification evidence</Text>
      </View>

      <Row label="Protocol" value={evidence.protocol ?? ""} />
      <Row label="CALID" value={evidence.calid.join(", ") || ""} />
      <Row label="ECU" value={evidence.ecuName ?? ""} />
      {/* Which build produced this screen. A screenshot cannot otherwise tell
          a new APK from the older file Android kept in Downloads, and that
          ambiguity has already cost one test round. */}
      <Row label="Build" value={BUILD_STAMP} />

      {/* Why each of the rows above is blank, when it is. Four dashes are one
          picture for four different problems — the ECU said NO DATA, the
          adapter said UNABLE TO CONNECT, the reply came back unparseable, or
          nothing came back at all — and only the last of those is about the
          car. Without this the screen blames the vehicle for the adapter's
          silence, and there is no way to tell which happened. */}
      {(evidence.reads ?? []).map((read, i) => (
        // Keyed by position, not by request. The same request legitimately
        // appears more than once on the list now — `1A 90` once as the
        // maker's own dialect and once per module it was addressed to, and
        // the whole connect again under a pinned protocol when the first pass
        // read nothing. Those repeats are different reads with different
        // bytes, and a key of `request` would have React collapse them into
        // one row.
        <View key={`${read.request}-${i}`}>
          <View style={styles.readRow}>
            <Text style={styles.readMark}>{READ_MARK[read.status]}</Text>
            <Text style={styles.readRequest}>{read.request}</Text>
            <Text style={styles.readDetail}>{read.detail ?? READ_LABEL[read.status]}</Text>
          </View>
          {/* What the adapter sent for this request, verbatim. A parsed value
              that looks wrong — a five-character VIN, a CALID full of `I`s —
              is a fact about the reply, and the reply is the only thing that
              can say whether the car answered in an unknown layout or the
              parser anchored on the wrong bytes. */}
          {(read.raw ?? []).map((line, i) => (
            <Text key={i} style={styles.readRaw} testID={`read-raw-${read.request}`}>
              {line}
            </Text>
          ))}
          {/* What the request cost in time, and what ended it. A read the
              adapter cut short (`STOPPED`) and a read the car never answered
              leave the same-shaped hole; only the duration tells them apart,
              and the screen is the one place a driver can see it. */}
          {read.timing ? (
            <Text style={styles.readTiming} testID={`read-timing-${read.request}`}>
              {read.timing}
            </Text>
          ) : null}
        </View>
      ))}

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
  readRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.xs,
    marginTop: 2,
  },
  readMark: {
    color: colors.onSurfaceTertiary,
    fontFamily: font.regular,
    fontSize: type.sm,
    width: 12,
  },
  readRequest: {
    color: colors.onSurfaceSecondary,
    fontFamily: font.regular,
    fontSize: type.sm,
    width: 46,
  },
  readDetail: {
    flex: 1,
    color: colors.onSurfaceTertiary,
    fontFamily: font.regular,
    fontSize: type.sm,
    lineHeight: 18,
  },
  // A real monospace face, which the app otherwise never uses: these lines
  // are bytes, and a fixed advance is what lets a reader compare two replies
  // by eye and see which one is a byte short. They wrap rather than clip —
  // a seventeen-character VIN plus its anchor is wider than the card, and the
  // characters past the fold are exactly the ones the reader came for.
  readRaw: {
    color: colors.onSurfaceTertiary,
    fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }),
    fontSize: type.sm,
    lineHeight: 16,
    marginLeft: 58,
  },
  // Dimmer than the bytes above it: the timing is the app's own measurement,
  // and it must not be mistaken for something the adapter said. Dimmer by
  // colour, not by size — the type scale has no step below `sm`, and a size
  // invented here would be the only one in the app.
  readTiming: {
    color: colors.borderStrong,
    fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }),
    fontSize: type.sm,
    lineHeight: 16,
    marginLeft: 58,
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
