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

The connect screen works in two modes, toggled with the **Demo mode** switch:

- **Demo** (default) — simulated adapters from `src/demo/obd.ts`; no hardware needed.
- **BLE** — real scan and connection to an ELM327 adapter (Vgate iCar Pro, vLinker, Viecar, KW902…) via `react-native-ble-plx`. The connection is verified with an ELM327 handshake (`ATZ` → `ATE0` → `ATI`) over the adapter's UART characteristic.

The transport layer lives in `src/obd/`:

- `transport.ts` — shared interface (`scanDevices` / `connect` / `disconnect`)
- `demo.ts` — simulation implementation
- `ble.ts` — real BLE implementation
- `at.ts` — ELM327 framing/parsing (unit-testable without hardware: `npx tsx scripts/elm327-smoke.ts`)

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

Install the resulting APK on the phone, then open the app, switch **Demo mode** off and search. If you have Android Studio installed, `npx expo run:android` builds the dev client locally instead.

Permissions are injected automatically by the `react-native-ble-plx` config plugin in `app.json` (`BLUETOOTH_SCAN`/`CONNECT` on Android 12+, location only below API 31, `NSBluetoothAlwaysUsageDescription` on iOS).

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
