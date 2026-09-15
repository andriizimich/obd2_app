# Welcome to your Expo app 👋

This is an [Expo](https://expo.dev) project created with [`create-expo-app`](https://www.npmjs.com/package/create-expo-app).

## Get started

1. Install dependencies

   ```bash
   npm install
   ```

2. Start the app

   ```bash
   npx expo start
   ```

In the output, you'll find options to open the app in a

- [development build](https://docs.expo.dev/develop/development-builds/introduction/)
- [Android emulator](https://docs.expo.dev/workflow/android-studio-emulator/)
- [iOS simulator](https://docs.expo.dev/workflow/ios-simulator/)
- [Expo Go](https://expo.dev/go), a limited sandbox for trying out app development with Expo

You can start developing by editing the files inside the **app** directory. This project uses [file-based routing](https://docs.expo.dev/router/introduction).

## Real BLE connection (OBD-II adapter)

The app reads from a real car only — there is no simulation mode, and no screen
shows invented data. Every number on screen came off the adapter, or the screen
says it could not be read. **Without an ELM327 plugged into a car, the app has
nothing to show past the connect screen.**

The connect screen scans for and connects to an ELM327 adapter (Vgate iCar Pro,
vLinker, Viecar, KW902…) over BLE via `react-native-ble-plx`, verifying the
handshake (`ATZ` → `ATE0` → `ATI`) over the adapter's UART characteristic.

The transport layer lives in `src/obd/`:

- `transport.ts` — shared interface (`scanDevices` / `connect` / `readVehicleInfo` / `readDiagnostics`)
- `ble.ts` / `classic.ts` — BLE and Bluetooth Classic implementations
- `real.ts` — picks between them
- `at.ts` — ELM327 framing/parsing (unit-testable without hardware: `npx tsx scripts/elm327-smoke.ts`)
- `frames.ts`, `dtc.ts`, `dtc-dictionary.ts`, `mode01.ts`, `mode03.ts`, `mode09.ts`, `diagnostics.ts` — the diagnostic pass

Fault-code titles come from `dtc-dictionary.ts`, a bundled table of standard
SAE J2012 codes. A code it does not hold is still decoded from its own bytes —
the system, the subsystem, whether it is SAE-defined or the manufacturer's —
and its description says so, rather than the row going blank.

`npm run smoke` runs the offline suites: synthetic adapter frames through the
real parsers. They prove the parsing logic, not the behaviour of any particular
adapter — see the section below.

### Running on a phone (BLE requires a development build)

Expo Go cannot run native Bluetooth modules — you need a development build. With no local Android SDK, use EAS cloud builds:

```bash
# one-time: log in and link the project
npx eas-cli login
npx eas-cli init

# build the dev client (APK with the dev launcher)
npx eas-cli build --profile development --platform android

# start the dev server; the phone connects to it via the dev client
npx expo start
```

Install the resulting APK on the phone, plug the adapter into the car's OBD-II
port, turn the ignition on and search. If you have Android Studio installed,
`npx expo run:android` builds the dev client locally instead.

Permissions are injected automatically by the `react-native-ble-plx` config plugin in `app.json` (`BLUETOOTH_SCAN`/`CONNECT` on Android 12+, location only below API 31, `NSBluetoothAlwaysUsageDescription` on iOS).

### What the offline suites do not prove

Everything in `npm run smoke` is fabricated bytes fed through the real parsers.
That covers the parsing logic and the honesty rules, and it does **not** cover:

- the `A6` divisor — the odometer is reported in 0.1 km units, so a wrong
  divisor shows a reading exactly ten times too large;
- whether a given clone honours `ATH1` and whether it prints the ISO-TP PCI
  byte;
- whether a given ECU answers `07`, `0A` or `A6` at all — many cars before
  ~2010 do not answer `0A`, and most do not answer `A6`;
- real timings, adapter resets and voltage sag.

Two surfaces exist precisely so the first real reading can settle these:

- **Adapter compatibility check** (dashboard, under the identification
  evidence) — runs `ATI`, `ATDPN`, `ATH1`, `0101`, `01A6`, `03` and shows
  every reply verbatim, then puts headers back with `ATH0`. One screenshot of
  this answers all four questions above.
- **Adapter output** (results screen) — the raw lines of the diagnostic pass
  itself, in order, as they came off the wire.

## Get a fresh project

When you're ready, run:

```bash
npm run reset-project
```

This command will move the starter code to the **app-example** directory and create a blank **app** directory where you can start developing.

## Learn more

To learn more about developing your project with Expo, look at the following resources:

- [Expo documentation](https://docs.expo.dev/): Learn fundamentals, or go into advanced topics with our [guides](https://docs.expo.dev/guides).
- [Learn Expo tutorial](https://docs.expo.dev/tutorial/introduction/): Follow a step-by-step tutorial where you'll create a project that runs on Android, iOS, and the web.

## Join the community

Join our community of developers creating universal apps.

- [Expo on GitHub](https://github.com/expo/expo): View our open source platform and contribute.
- [Discord community](https://chat.expo.dev): Chat with Expo users and ask questions.
