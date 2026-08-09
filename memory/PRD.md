# radacini — OBD-II Diagnostics App (PRD)

## Original Problem Statement
Mobile app to work with an OBD-II diagnostic adapter plugged into a car.
1. User plugs the OBD adapter into the car (out of app scope).
2. Phone searches for the connected device via Bluetooth.
3. In-app "Connect" verifies the connection. If no adapter → error message advising to reconnect the device and check Bluetooth settings. On success → screen with vehicle info (VIN, make, model, year, mileage) and a "Scan car" button.
4. "Read/View errors" reads stored fault codes (DTCs). If faults exist → list with error code + system group (engine/transmission/lights/etc). If none → "No errors" state. Both have a "Send check result" button.
Interfaces in English; team communicates in Ukrainian. Modern UI, highly readable text.

## User Choices
- Bluetooth: **demo/simulation mode first**, real BLE later.
- "Send check result" → **save to database**.
- Design: **dark neon "radacini" theme** (black + neon cyan).
- **Scan history** required.

## Architecture
- Frontend: Expo Router (React Native, SDK 54). Fonts: Rajdhani (display) + IBM Plex Sans (body) via expo-font.
- Backend: FastAPI, MongoDB (motor). All routes under `/api`.
- State: in-memory `ObdContext` (device + vehicle + last scan). Demo layer in `src/demo/obd.ts` generates devices/vehicle/fault codes.
- Persistence: scans saved to Mongo `scans` collection (uuid ids, `_id` excluded).

## Screens
- `app/index.tsx` — Connect (search → connect, error/troubleshoot state, demo unplug toggle).
- `app/(tabs)/dashboard.tsx` — Vehicle info (VIN/make/model/year/mileage) + Scan Car.
- `app/fault-codes.tsx` — scanning progress → fault list (grouped, color-coded) or "All Systems Go" → Send check result.
- `app/(tabs)/history.tsx` — saved scans list, pull-to-refresh, empty state.
- `app/scan/[id].tsx` — scan detail + delete.

## Backend API
- `GET /api/` health
- `POST /api/scans` create (auto status ok/faults + fault_count)
- `GET /api/scans` list (desc by created_at)
- `GET /api/scans/{id}` / `DELETE /api/scans/{id}`

## Implemented (2026-06)
- Full demo flow Connect → Dashboard → Scan → Results → Send → History → Detail/Delete.
- Dark neon radacini theme, custom fonts, haptics, toasts.
- Tested: backend 8/8 pytest passing; all frontend flows verified by testing agent.

## Backlog / Next
- P1: Real Bluetooth (BLE) OBD integration (requires native build; replaces demo layer).
- P1: Share/export scan result as PDF.
- P2: Live sensor data (RPM, coolant temp, live gauges).
- P2: Clear/reset fault codes command.
- P2: Multiple saved vehicle profiles.
