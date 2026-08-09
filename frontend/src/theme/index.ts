// radacini design tokens — Dark-First Utility (neon cyan on deep black)
export const colors = {
  surface: "#050505",
  onSurface: "#FFFFFF",
  surfaceSecondary: "#121214",
  onSurfaceSecondary: "#E0E0E0",
  surfaceTertiary: "#1C1C1F",
  onSurfaceTertiary: "#A0A0A5",

  brand: "#00E5FF",
  onBrand: "#000000",
  brandSecondary: "#00A3FF",
  brandTertiary: "#003344",

  success: "#00FF66",
  onSuccess: "#000000",
  warning: "#FFD600",
  error: "#FF2A55",
  onError: "#FFFFFF",

  border: "#2C2C30",
  borderStrong: "#4A4A52",
  divider: "#1C1C1F",

  // fault system groups
  engine: "#FF9900",
  transmission: "#9D00FF",
  lights: "#FFD600",
  brakes: "#FF2A55",
  emissions: "#00FF66",
  electrical: "#00A3FF",
  body: "#A0A0A5",
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  "2xl": 32,
  "3xl": 48,
} as const;

export const radius = {
  sm: 6,
  md: 12,
  lg: 20,
  pill: 999,
} as const;

export const font = {
  // display / technical
  display: "Rajdhani-Bold",
  displaySemi: "Rajdhani-SemiBold",
  displayMed: "Rajdhani-Medium",
  displayReg: "Rajdhani-Regular",
  // body
  regular: "IBMPlexSans-Regular",
  medium: "IBMPlexSans-Medium",
  semibold: "IBMPlexSans-SemiBold",
} as const;

export const type = {
  sm: 12,
  base: 14,
  lg: 16,
  xl: 20,
  "2xl": 24,
} as const;

export const groupColor = (group: string): string => {
  const g = group.toLowerCase();
  return (colors as Record<string, string>)[g] ?? colors.brand;
};
