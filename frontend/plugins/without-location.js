const { withAndroidManifest, AndroidConfig } = require("@expo/config-plugins");

/**
 * Strip every location permission from the merged Android manifest.
 *
 * `react-native-ble-plx` adds ACCESS_FINE_LOCATION and ACCESS_COARSE_LOCATION
 * (as `uses-permission-sdk-23`) because BLE scanning below Android 12 needs
 * them. This app asks for nothing location-related, so the entries only make
 * the install look like it tracks the driver.
 *
 * Two things are needed for that to actually hold, which is why this is a
 * plugin and not `android.blockedPermissions`:
 *
 *   1. Drop the entries from the arrays the BLE plugin filled in — they live
 *      under `uses-permission-sdk-23`, an element type that
 *      `blockedPermissions` (which writes to `uses-permission`) does not
 *      touch.
 *   2. Leave a `tools:node="remove"` marker under each name, so that a
 *      location permission declared by a library's own manifest — merged in
 *      after this plugin runs — is removed by the manifest merger. Markers
 *      are written to both element types, so the result does not depend on
 *      whether this plugin runs before or after the BLE plugin.
 *
 * The cost is deliberate and the app states it: Android 11 and older require
 * the location grant for a BLE scan, so `ensureBleReady` refuses to scan
 * there rather than requesting a permission the manifest no longer declares.
 */
const LOCATION_PERMISSIONS = [
  "android.permission.ACCESS_FINE_LOCATION",
  "android.permission.ACCESS_COARSE_LOCATION",
];

const ELEMENT_TYPES = ["uses-permission", "uses-permission-sdk-23"];

module.exports = function withoutLocation(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    if (!manifest.$) manifest.$ = {};
    AndroidConfig.Manifest.ensureToolsAvailable(cfg.modResults);

    for (const type of ELEMENT_TYPES) {
      const entries = Array.isArray(manifest[type]) ? manifest[type] : [];
      const kept = entries.filter(
        (entry) => !LOCATION_PERMISSIONS.includes(entry?.$?.["android:name"]),
      );
      // A single remove marker per name; duplicates of the same key within
      // one manifest are a merge error.
      for (const name of LOCATION_PERMISSIONS) {
        kept.push({ $: { "android:name": name, "tools:node": "remove" } });
      }
      manifest[type] = kept;
    }

    return cfg;
  });
};
