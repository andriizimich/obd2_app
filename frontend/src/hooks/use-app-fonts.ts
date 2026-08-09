// Custom brand fonts for radacini.
// Rajdhani  -> technical display / numeric readouts / headers
// IBMPlexSans -> body & descriptions (high readability)
import { useFonts } from "expo-font";

export const useAppFonts = (): readonly [boolean, Error | null] =>
  useFonts({
    "Rajdhani-Regular": require("../../assets/fonts/Rajdhani-Regular.ttf"),
    "Rajdhani-Medium": require("../../assets/fonts/Rajdhani-Medium.ttf"),
    "Rajdhani-SemiBold": require("../../assets/fonts/Rajdhani-SemiBold.ttf"),
    "Rajdhani-Bold": require("../../assets/fonts/Rajdhani-Bold.ttf"),
    "IBMPlexSans-Regular": require("../../assets/fonts/IBMPlexSans-Regular.ttf"),
    "IBMPlexSans-Medium": require("../../assets/fonts/IBMPlexSans-Medium.ttf"),
    "IBMPlexSans-SemiBold": require("../../assets/fonts/IBMPlexSans-SemiBold.ttf"),
  });
