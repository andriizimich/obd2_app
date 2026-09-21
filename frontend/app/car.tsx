import { MaterialCommunityIcons } from "@expo/vector-icons";
import { Redirect, useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import React, { useMemo, useState } from "react";
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import NeonButton from "@/src/components/NeonButton";
import { useObd } from "@/src/context/ObdContext";
import {
  filterByName,
  lastYearOf,
  MAKES,
  modelLabel,
  yearsOf,
  type Generation,
  type Make,
  type Model,
} from "@/src/data/vehicles";
import { colors, font, radius, spacing, type } from "@/src/theme";

/**
 * The car, in four questions.
 *
 * This screen exists because the adapter could not answer them. Mode 09 was
 * the app's first way of learning what it was plugged into, and on the cars
 * it actually met the answer was `BUS BUSY`, `NO DATA`, or five characters
 * of a KWP2000 frame. Asking the driver is not a fallback — it is faster,
 * it is always right, and it is the only one of the two that has ever
 * produced an answer.
 *
 * The year is not a question when the generation already answers it, and the
 * generation is not one when the model only ever had one. The stage list is
 * derived from the picks rather than fixed at four, so a Dacia Sandero of a
 * single-generation span costs three taps instead of four.
 */

type Stage = "make" | "model" | "generation" | "year";

const PROMPT: Record<Stage, string> = {
  make: "Which make is it?",
  model: "Which model?",
  generation: "Which generation?",
  year: "Which year?",
};

/**
 * How many rows before a search field earns its place.
 *
 * Below this the list fits on one screen and a keyboard would cover half of
 * it for no gain; above it — 22 Volkswagen models, 21 Mercedes — typing two
 * letters beats scrolling.
 */
const SEARCH_FROM = 9;

type Row = {
  key: string;
  label: string;
  /** The year span, for a generation. */
  sub?: string;
};

export default function CarScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { device, transport, setVehicle } = useObd();

  const [make, setMake] = useState<Make | null>(null);
  const [model, setModel] = useState<Model | null>(null);
  const [generation, setGeneration] = useState<Generation | null>(null);
  const [year, setYear] = useState<number | null>(null);
  const [step, setStep] = useState(0);
  const [query, setQuery] = useState("");

  const currentYear = useMemo(() => new Date().getFullYear(), []);

  // The generation in force, which is the picked one or the only one there
  // is. Kept separate from the pick so that "the model has one generation"
  // does not need a state write to become true.
  const gen = generation ?? (model?.generations.length === 1 ? model.generations[0] : null);
  const years = useMemo(
    () => (gen ? yearsOf(gen, currentYear) : []),
    [gen, currentYear],
  );
  const yr = year ?? (years.length === 1 ? years[0] : null);

  const stages = useMemo<Stage[]>(() => {
    const out: Stage[] = ["make"];
    if (!make) return out;
    out.push("model");
    if (!model) return out;
    const g =
      generation ?? (model.generations.length === 1 ? model.generations[0] : null);
    // Only asked when there is something to choose between. A model built
    // for twenty years without a redesign has one generation, and a screen
    // that makes the driver pick it from a list of one is a screen that
    // wasted a tap.
    if (model.generations.length > 1) {
      out.push("generation");
      if (!g) return out;
    }
    if (g && yearsOf(g, currentYear).length > 1) out.push("year");
    return out;
  }, [make, model, generation, currentYear]);

  const stage: Stage | null = stages[step] ?? null;
  const complete = make !== null && model !== null && gen !== null && yr !== null;

  const rows: Row[] = useMemo(() => {
    if (stage === "make") {
      return filterByName(MAKES, query).map((m) => ({
        key: m.id,
        label: m.name,
        sub: `${m.models.length} model${m.models.length === 1 ? "" : "s"}`,
      }));
    }
    if (stage === "model" && make) {
      return filterByName(make.models, query).map((m) => ({
        key: m.id,
        label: m.name,
      }));
    }
    if (stage === "generation" && model) {
      return filterByName(model.generations, query).map((g) => ({
        key: g.id,
        label: g.name,
        sub: `${g.from}–${lastYearOf(g, currentYear)}`,
      }));
    }
    if (stage === "year") {
      return years.map((y) => ({ key: String(y), label: String(y) }));
    }
    return [];
  }, [stage, make, model, query, years, currentYear]);

  // Every hook is above this line — the early return below must not sit
  // between two of them.
  if (!device || !transport) return <Redirect href="/" />;

  const clearFrom = (from: Stage) => {
    if (from === "make") {
      setMake(null);
      setModel(null);
      setGeneration(null);
      setYear(null);
    } else if (from === "model") {
      setModel(null);
      setGeneration(null);
      setYear(null);
    } else if (from === "generation") {
      setGeneration(null);
      setYear(null);
    } else {
      setYear(null);
    }
  };

  const advance = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setQuery("");
    setStep((s) => s + 1);
  };

  const goBack = () => {
    if (step === 0) {
      router.replace("/");
      return;
    }
    // Back means back to the question that was answered, so its answer goes
    // with it — and so does everything after it, which was chosen in terms
    // of an answer that is about to change. A `Logan III` year range makes
    // no sense under a `Logan II`.
    clearFrom(stages[step - 1]);
    setQuery("");
    setStep(step - 1);
  };

  /** Jump the trail back to an earlier question, from the summary. */
  const jumpTo = (target: Stage) => {
    const index = stages.indexOf(target);
    if (index < 0 || index >= step) return;
    clearFrom(target);
    setQuery("");
    setStep(index);
  };

  const pick = (key: string) => {
    if (stage === "make") {
      const found = MAKES.find((m) => m.id === key);
      if (!found) return;
      setMake(found);
      setModel(null);
      setGeneration(null);
      setYear(null);
      advance();
      return;
    }
    if (stage === "model" && make) {
      const found = make.models.find((m) => m.id === key);
      if (!found) return;
      setModel(found);
      setGeneration(null);
      setYear(null);
      advance();
      return;
    }
    if (stage === "generation" && model) {
      const found = model.generations.find((g) => g.id === key);
      if (!found) return;
      setGeneration(found);
      setYear(null);
      advance();
      return;
    }
    if (stage === "year") {
      setYear(Number(key));
      advance();
    }
  };

  const onDiagnose = () => {
    if (!make || !model || !gen || yr === null) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    setVehicle({
      // No VIN, and the empty string is the honest value for it. The report
      // prints a VIN line only when there is one, so this cannot come out as
      // a car that gave a VIN of nothing.
      vin: "",
      make: make.name,
      model: modelLabel(model, gen),
      year: yr,
      mileage: null,
      // Told, not read. Every screen that shows this car is showing what the
      // driver typed, and `manual` is how the rest of the app knows that.
      confidence: "manual",
    });
    router.push("/results");
  };

  const trail: { stage: Stage; label: string }[] = [
    { stage: "make", label: make?.name ?? "Make" },
    { stage: "model", label: model?.name ?? "Model" },
    { stage: "generation", label: gen && model ? modelLabel(model, gen) : "Generation" },
    { stage: "year", label: yr !== null ? String(yr) : "Year" },
  ];

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <Pressable
          testID="car-back-button"
          onPress={goBack}
          hitSlop={12}
          style={styles.backBtn}
        >
          <MaterialCommunityIcons
            name="chevron-left"
            size={26}
            color={colors.onSurface}
          />
        </Pressable>
        <Text style={styles.headerTitle}>Your car</Text>
        <View style={{ width: 26 }} />
      </View>

      {/* The trail is the way back to any earlier answer. Rendering only the
          questions this car actually asks keeps it from promising a step
          (a generation, for a model that had one) that never comes. */}
      <View style={styles.trail}>
        {trail
          .filter((t) => stages.includes(t.stage))
          .map((t) => {
            const answered = stages.indexOf(t.stage) < step;
            const active = t.stage === stage;
            return (
              <Pressable
                key={t.stage}
                testID={`trail-${t.stage}`}
                onPress={() => jumpTo(t.stage)}
                disabled={!answered}
                style={[
                  styles.pill,
                  answered && styles.pillAnswered,
                  active && styles.pillActive,
                ]}
              >
                <Text
                  style={[
                    styles.pillText,
                    answered && styles.pillTextAnswered,
                    active && styles.pillTextActive,
                  ]}
                  numberOfLines={1}
                >
                  {t.label}
                </Text>
              </Pressable>
            );
          })}
      </View>

      {stage ? (
        <>
          <Text style={styles.prompt} testID="car-prompt">
            {PROMPT[stage]}
          </Text>

          {rows.length >= SEARCH_FROM && (
            <View style={styles.searchBox}>
              <MaterialCommunityIcons
                name="magnify"
                size={18}
                color={colors.onSurfaceTertiary}
              />
              <TextInput
                testID="car-search"
                value={query}
                onChangeText={setQuery}
                placeholder="Search"
                placeholderTextColor={colors.onSurfaceTertiary}
                autoCorrect={false}
                autoCapitalize="none"
                style={styles.searchInput}
              />
              {query.length > 0 && (
                <Pressable onPress={() => setQuery("")} hitSlop={8}>
                  <MaterialCommunityIcons
                    name="close-circle"
                    size={18}
                    color={colors.onSurfaceTertiary}
                  />
                </Pressable>
              )}
            </View>
          )}

          <FlatList
            data={rows}
            keyExtractor={(row) => row.key}
            // A pick made while the keyboard is up has to land on the row,
            // not dismiss the keyboard. Without this, searching for a model
            // and tapping it does nothing at all.
            keyboardShouldPersistTaps="handled"
            initialNumToRender={20}
            contentContainerStyle={styles.list}
            showsVerticalScrollIndicator={false}
            testID="car-list"
            renderItem={({ item }) => (
              <Pressable
                testID={`car-row-${item.key}`}
                onPress={() => pick(item.key)}
                style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
              >
                <Text style={styles.rowLabel} numberOfLines={1}>
                  {item.label}
                </Text>
                {item.sub ? <Text style={styles.rowSub}>{item.sub}</Text> : null}
                <MaterialCommunityIcons
                  name="chevron-right"
                  size={20}
                  color={colors.onSurfaceTertiary}
                />
              </Pressable>
            )}
            ListEmptyComponent={
              <Text style={styles.empty}>Nothing matches that.</Text>
            }
          />
        </>
      ) : (
        <View style={styles.summary} testID="car-summary">
          <View style={styles.summaryIcon}>
            <MaterialCommunityIcons name="car" size={44} color={colors.brand} />
          </View>
          <Text style={styles.summaryCar} testID="car-summary-name">
            {make?.name} {model && gen ? modelLabel(model, gen) : ""}
          </Text>
          <Text style={styles.summaryYear}>{yr}</Text>
          <Text style={styles.summaryHint}>
            Tap a value above to change it.
          </Text>
        </View>
      )}

      <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.md }]}>
        <NeonButton
          testID="diagnose-button"
          label="Diagnose"
          icon="radar"
          onPress={onDiagnose}
          disabled={!complete}
        />
      </View>
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
  backBtn: { width: 26, alignItems: "flex-start" },
  headerTitle: {
    color: colors.onSurface,
    fontFamily: font.displaySemi,
    fontSize: type.xl,
    letterSpacing: 0.5,
  },
  trail: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  pill: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 5,
    maxWidth: "100%",
  },
  pillAnswered: { borderColor: colors.brandTertiary, backgroundColor: colors.surfaceSecondary },
  pillActive: { borderColor: colors.brand },
  pillText: {
    color: colors.onSurfaceTertiary,
    fontFamily: font.medium,
    fontSize: type.sm,
  },
  pillTextAnswered: { color: colors.onSurfaceSecondary },
  pillTextActive: { color: colors.brand },
  prompt: {
    color: colors.onSurface,
    fontFamily: font.display,
    fontSize: 22,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
  },
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
  },
  searchInput: {
    flex: 1,
    color: colors.onSurface,
    fontFamily: font.regular,
    fontSize: type.base,
    paddingVertical: spacing.md,
  },
  list: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg, gap: spacing.sm },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  rowPressed: { borderColor: colors.brand, opacity: 0.8 },
  rowLabel: {
    flex: 1,
    color: colors.onSurface,
    fontFamily: font.semibold,
    fontSize: type.lg,
  },
  rowSub: {
    color: colors.onSurfaceTertiary,
    fontFamily: font.regular,
    fontSize: type.sm,
  },
  empty: {
    color: colors.onSurfaceTertiary,
    fontFamily: font.regular,
    fontSize: type.base,
    textAlign: "center",
    paddingTop: spacing.xl,
  },
  summary: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.sm },
  summaryIcon: {
    width: 96,
    height: 96,
    borderRadius: 48,
    borderWidth: 2,
    borderColor: colors.brand,
    backgroundColor: colors.surfaceSecondary,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.md,
  },
  summaryCar: {
    color: colors.onSurface,
    fontFamily: font.display,
    fontSize: 30,
    textAlign: "center",
    paddingHorizontal: spacing.lg,
  },
  summaryYear: {
    color: colors.brand,
    fontFamily: font.displayMed,
    fontSize: type.xl,
    letterSpacing: 1,
  },
  summaryHint: {
    color: colors.onSurfaceTertiary,
    fontFamily: font.regular,
    fontSize: type.sm,
    marginTop: spacing.md,
  },
  footer: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
});
