// Offline lookup table of standard SAE J2012 diagnostic trouble codes.
// Codes missing from this table fall back to the structural parsing in
// `dtc.ts`, which derives the group, the title and a severity from the bytes.
// The group is deliberately NOT stored here: one rule decides it for every
// code, table or not, so the two can never disagree.

import type { FaultSeverity } from "@/src/obd/types";

export type DtcEntry = {
  title: string;
  description: string;
  severity: FaultSeverity;
  causes?: string[];
};

export const DTC_DICTIONARY: Readonly<Record<string, DtcEntry>> = {
  // --- Variable valve timing (P001x) ---
  "P0010": { title: "Camshaft Position Actuator A Circuit (Bank 1)", description: "The oil control valve that varies camshaft timing is not responding electrically.", severity: "medium" },
  "P0011": { title: "Camshaft Position A Timing Over-Advanced (Bank 1)", description: "Camshaft timing is stuck advanced, so the engine runs rough and loses power.", severity: "medium", causes: ["stuck variable valve timing solenoid", "dirty or low engine oil", "stretched timing chain"] },
  "P0012": { title: "Camshaft Position A Timing Over-Retarded (Bank 1)", description: "Camshaft timing is stuck retarded, costing low-end torque and fuel economy.", severity: "medium" },
  "P0016": { title: "Crankshaft/Camshaft Position Correlation (Bank 1 A)", description: "The crankshaft and camshaft signals disagree, so valve timing cannot be trusted.", severity: "medium", causes: ["stretched timing chain or belt", "failed camshaft phaser", "misaligned timing marks"] },
  "P0017": { title: "Crankshaft/Camshaft Position Correlation (Bank 1 B)", description: "The camshaft and crankshaft signals disagree on the exhaust side of bank 1.", severity: "medium", causes: ["worn timing chain and tensioner", "faulty camshaft position sensor", "jumped timing tooth"] },

  // --- Fuel and air metering (P01xx) ---
  "P0100": { title: "Mass Air Flow Circuit Malfunction", description: "The engine computer receives no usable signal from the mass air flow sensor.", severity: "medium" },
  "P0101": { title: "Mass Air Flow Circuit Range/Performance", description: "Air flow readings do not match engine load, so fuelling is calculated wrong.", severity: "medium" },
  "P0102": { title: "Mass Air Flow Circuit Low Input", description: "The mass air flow sensor signal is below the range a working sensor can produce.", severity: "medium" },
  "P0103": { title: "Mass Air Flow Circuit High Input", description: "The mass air flow sensor signal is above the range a working sensor can produce.", severity: "medium" },
  "P0105": { title: "Manifold Absolute Pressure Circuit Malfunction", description: "The manifold pressure sensor circuit is open, shorted or unreadable.", severity: "medium" },
  "P0106": { title: "Manifold Absolute Pressure Range/Performance", description: "Manifold pressure does not track throttle position and engine speed as it should.", severity: "medium" },
  "P0107": { title: "Manifold Absolute Pressure Circuit Low Input", description: "The manifold pressure sensor reports a voltage below anything physically possible.", severity: "medium" },
  "P0108": { title: "Manifold Absolute Pressure Circuit High Input", description: "The manifold pressure sensor reports a voltage above anything physically possible.", severity: "medium" },
  "P0110": { title: "Intake Air Temperature Circuit Malfunction", description: "The intake air temperature sensor circuit is open or shorted.", severity: "medium" },
  "P0112": { title: "Intake Air Temperature Circuit Low Input", description: "The intake air temperature sensor reads hotter than the air can possibly be.", severity: "medium" },
  "P0113": { title: "Intake Air Temperature Circuit High Input", description: "The intake air temperature sensor reads colder than the air can possibly be.", severity: "medium", causes: ["unplugged intake air temperature sensor", "damaged sensor wiring", "failed sensor element"] },
  "P0115": { title: "Engine Coolant Temperature Circuit Malfunction", description: "The coolant temperature sensor circuit is open or shorted.", severity: "medium" },
  "P0116": { title: "Engine Coolant Temperature Range/Performance", description: "Coolant temperature rises too slowly or too fast for how the engine is driven.", severity: "medium" },
  "P0120": { title: "Throttle Position Sensor A Circuit Malfunction", description: "The throttle position sensor circuit is open, shorted or unreadable.", severity: "high" },
  "P0121": { title: "Throttle Position Sensor A Range/Performance", description: "Throttle position readings do not agree with manifold pressure and engine speed.", severity: "high" },
  "P0122": { title: "Throttle Position Sensor A Circuit Low Input", description: "The throttle position sensor voltage is below the valid range.", severity: "high" },
  "P0123": { title: "Throttle Position Sensor A Circuit High Input", description: "The throttle position sensor voltage is above the valid range.", severity: "high" },
  "P0128": { title: "Coolant Thermostat Below Regulating Temperature", description: "The thermostat opens too early or sticks open, so the engine runs cold.", severity: "medium", causes: ["stuck-open thermostat", "low coolant level", "faulty coolant temperature sensor"] },
  "P0130": { title: "O2 Sensor Circuit Malfunction (Bank 1 Sensor 1)", description: "The upstream oxygen sensor on bank 1 is not producing a usable signal.", severity: "medium" },
  "P0131": { title: "O2 Sensor Circuit Low Voltage (Bank 1 Sensor 1)", description: "The upstream oxygen sensor on bank 1 is stuck reporting a lean mixture.", severity: "medium" },
  "P0132": { title: "O2 Sensor Circuit High Voltage (Bank 1 Sensor 1)", description: "The upstream oxygen sensor on bank 1 is stuck reporting a rich mixture.", severity: "medium" },
  "P0133": { title: "O2 Sensor Circuit Slow Response (Bank 1 Sensor 1)", description: "The upstream oxygen sensor on bank 1 reacts too slowly to mixture changes.", severity: "medium" },
  "P0134": { title: "O2 Sensor Circuit No Activity (Bank 1 Sensor 1)", description: "The upstream oxygen sensor on bank 1 shows no voltage activity at all.", severity: "medium" },
  "P0135": { title: "O2 Sensor Heater Circuit (Bank 1 Sensor 1)", description: "The heater inside the upstream oxygen sensor on bank 1 is not working.", severity: "medium", causes: ["failed oxygen sensor heater", "blown heater fuse", "damaged heater wiring"] },
  "P0141": { title: "O2 Sensor Heater Circuit (Bank 1 Sensor 2)", description: "The heater inside the downstream oxygen sensor on bank 1 is not working.", severity: "medium", causes: ["failed oxygen sensor heater", "blown heater fuse", "corroded sensor connector"] },
  "P0151": { title: "O2 Sensor Circuit Low Voltage (Bank 2 Sensor 1)", description: "The upstream oxygen sensor on bank 2 is stuck reporting a lean mixture.", severity: "medium" },
  "P0171": { title: "System Too Lean (Bank 1)", description: "Bank 1 runs lean, so the computer adds more fuel than the design allows.", severity: "medium", causes: ["vacuum or intake leak", "dirty mass air flow sensor", "weak fuel pump or clogged filter"] },
  "P0172": { title: "System Too Rich (Bank 1)", description: "Bank 1 runs rich, so the computer removes more fuel than the design allows.", severity: "medium" },
  "P0174": { title: "System Too Lean (Bank 2)", description: "Bank 2 runs lean, so the computer adds more fuel than the design allows.", severity: "medium", causes: ["vacuum leak on bank 2", "dirty mass air flow sensor", "clogged fuel injectors"] },

  // --- Injectors, fuel pump, boost (P02xx) ---
  "P0200": { title: "Injector Circuit Malfunction", description: "At least one fuel injector circuit is open, shorted or drawing wrong current.", severity: "medium" },
  "P0201": { title: "Injector Circuit Malfunction (Cylinder 1)", description: "The fuel injector circuit for cylinder 1 is open, shorted or unreadable.", severity: "medium" },
  "P0202": { title: "Injector Circuit Malfunction (Cylinder 2)", description: "The fuel injector circuit for cylinder 2 is open, shorted or unreadable.", severity: "medium" },
  "P0203": { title: "Injector Circuit Malfunction (Cylinder 3)", description: "The fuel injector circuit for cylinder 3 is open, shorted or unreadable.", severity: "medium" },
  "P0204": { title: "Injector Circuit Malfunction (Cylinder 4)", description: "The fuel injector circuit for cylinder 4 is open, shorted or unreadable.", severity: "medium" },
  "P0217": { title: "Engine Over Temperature Condition", description: "The engine has overheated and needs to be shut down before damage occurs.", severity: "high" },
  "P0230": { title: "Fuel Pump Primary Circuit Malfunction", description: "The fuel pump relay control circuit is not switching the pump on as commanded.", severity: "medium" },
  "P0231": { title: "Fuel Pump Secondary Circuit Low", description: "The fuel pump monitor circuit reads low, meaning the pump may not be running.", severity: "medium" },
  "P0232": { title: "Fuel Pump Secondary Circuit High", description: "The fuel pump monitor circuit reads high, pointing to a short to power.", severity: "medium" },
  "P0234": { title: "Turbocharger Overboost Condition", description: "Boost pressure rose above the safe limit and the computer cut engine power.", severity: "medium" },
  "P0235": { title: "Turbocharger Boost Sensor A Circuit Malfunction", description: "The boost pressure sensor signal is missing or outside the valid range.", severity: "medium" },
  "P0237": { title: "Turbocharger Boost Sensor A Circuit Low", description: "The boost pressure sensor reports less pressure than the engine can make.", severity: "medium" },
  "P0261": { title: "Cylinder 1 Injector Circuit Low", description: "The injector for cylinder 1 is drawing less current than it should.", severity: "medium" },
  "P0263": { title: "Cylinder 1 Contribution/Balance Fault", description: "Cylinder 1 is contributing less power than the other cylinders.", severity: "medium" },
  "P0299": { title: "Turbocharger Underboost Condition", description: "The turbo never builds the boost pressure the computer asked it for.", severity: "medium" },

  // --- Misfire and engine position (P03xx) ---
  "P0300": { title: "Random/Multiple Cylinder Misfire Detected", description: "Multiple cylinders are misfiring, which dumps unburnt fuel into the catalyst.", severity: "high", causes: ["worn or fouled spark plugs", "failed ignition coil", "vacuum leak"] },
  "P0301": { title: "Cylinder 1 Misfire Detected", description: "Cylinder 1 is not burning its fuel, so the engine shakes and loses power.", severity: "high", causes: ["fouled spark plug in cylinder 1", "failed ignition coil", "clogged fuel injector"] },
  "P0302": { title: "Cylinder 2 Misfire Detected", description: "Cylinder 2 is not burning its fuel, so the engine shakes and loses power.", severity: "high", causes: ["fouled spark plug in cylinder 2", "failed ignition coil", "low compression"] },
  "P0303": { title: "Cylinder 3 Misfire Detected", description: "Cylinder 3 is not burning its fuel, so the engine shakes and loses power.", severity: "high", causes: ["fouled spark plug in cylinder 3", "failed ignition coil", "clogged fuel injector"] },
  "P0304": { title: "Cylinder 4 Misfire Detected", description: "Cylinder 4 is not burning its fuel, so the engine shakes and loses power.", severity: "high", causes: ["fouled spark plug in cylinder 4", "failed ignition coil", "vacuum leak at intake"] },
  "P0305": { title: "Cylinder 5 Misfire Detected", description: "Cylinder 5 is not burning its fuel, so the engine shakes and loses power.", severity: "high", causes: ["fouled spark plug in cylinder 5", "failed ignition coil", "worn spark plug wires"] },
  "P0306": { title: "Cylinder 6 Misfire Detected", description: "Cylinder 6 is not burning its fuel, so the engine shakes and loses power.", severity: "high" },
  "P0307": { title: "Cylinder 7 Misfire Detected", description: "Cylinder 7 is not burning its fuel, so the engine shakes and loses power.", severity: "high" },
  "P0308": { title: "Cylinder 8 Misfire Detected", description: "Cylinder 8 is not burning its fuel, so the engine shakes and loses power.", severity: "high" },
  "P0325": { title: "Knock Sensor 1 Circuit (Bank 1)", description: "The knock sensor circuit is not delivering a signal, so timing cannot be trimmed.", severity: "medium" },
  "P0335": { title: "Crankshaft Position Sensor A Circuit", description: "The crankshaft position sensor is not sending a signal the computer can read.", severity: "medium", causes: ["damaged crankshaft sensor wiring", "failed crankshaft position sensor", "cracked reluctor ring"] },
  "P0336": { title: "Crankshaft Position Sensor A Range/Performance", description: "The crankshaft position signal is present but drops out or has gaps.", severity: "medium" },
  "P0340": { title: "Camshaft Position Sensor A Circuit (Bank 1)", description: "The camshaft position sensor signal is missing or unusable.", severity: "medium" },
  "P0341": { title: "Camshaft Position Sensor A Range/Performance", description: "The camshaft position signal is erratic or does not match engine speed.", severity: "medium" },
  "P0351": { title: "Ignition Coil A Primary/Secondary Circuit", description: "The ignition coil circuit for the first coil is open, shorted or unreadable.", severity: "medium" },
  "P0380": { title: "Glow Plug/Heater Circuit A", description: "The glow plug circuit on a diesel engine is open or shorted.", severity: "medium" },

  // --- EGR, EVAP and catalyst (P04xx) ---
  "P0400": { title: "Exhaust Gas Recirculation Flow Malfunction", description: "The EGR system is not flowing the amount of exhaust gas the computer expects.", severity: "medium" },
  "P0401": { title: "EGR Flow Insufficient Detected", description: "Too little exhaust gas is being recirculated, so NOx emissions rise.", severity: "medium", causes: ["clogged EGR passages", "failed EGR valve", "faulty differential pressure sensor"] },
  "P0402": { title: "EGR Flow Excessive Detected", description: "Too much exhaust gas is recirculated, causing rough running and stalling.", severity: "medium" },
  "P0403": { title: "EGR Circuit Malfunction", description: "The EGR valve control circuit is open, shorted or unreadable.", severity: "medium" },
  "P0404": { title: "EGR Circuit Range/Performance", description: "The EGR valve does not move to the position the computer commands.", severity: "medium" },
  "P0405": { title: "EGR Sensor A Circuit Low", description: "The EGR valve position sensor reports a voltage below the valid range.", severity: "medium" },
  "P0406": { title: "EGR Sensor A Circuit High", description: "The EGR valve position sensor reports a voltage above the valid range.", severity: "medium" },
  "P0410": { title: "Secondary Air Injection System Malfunction", description: "The air pump that feeds extra air into the exhaust is not working.", severity: "medium" },
  "P0411": { title: "Secondary Air Injection Incorrect Flow Detected", description: "The secondary air system flows the wrong amount of air into the exhaust.", severity: "medium" },
  "P0420": { title: "Catalyst System Efficiency Below Threshold (Bank 1)", description: "The bank 1 catalytic converter is no longer cleaning the exhaust well enough.", severity: "medium", causes: ["failed catalytic converter", "worn oxygen sensor", "exhaust leak before catalyst"] },
  "P0430": { title: "Catalyst System Efficiency Below Threshold (Bank 2)", description: "The bank 2 catalytic converter is no longer cleaning the exhaust well enough.", severity: "medium", causes: ["failed catalytic converter", "worn oxygen sensor", "exhaust leak on bank 2"] },
  "P0440": { title: "Evaporative Emission System Malfunction", description: "The EVAP system that traps fuel vapour is not sealing or purging correctly.", severity: "medium" },
  "P0441": { title: "Evaporative Emission System Incorrect Purge Flow", description: "Fuel vapour is being purged at a rate the computer did not ask for.", severity: "medium" },
  "P0442": { title: "Evaporative Emission System Leak (Small Leak)", description: "The EVAP system has a small vapour leak, often from a loose fuel cap.", severity: "low", causes: ["loose or worn fuel cap", "cracked EVAP hose", "faulty purge valve"] },
  "P0443": { title: "Evaporative Emission Purge Control Valve Circuit", description: "The purge valve control circuit is open, shorted or unreadable.", severity: "medium" },
  "P0446": { title: "Evaporative Emission Vent Control Circuit", description: "The vent valve control circuit is open, shorted or unreadable.", severity: "medium" },
  "P0449": { title: "Evaporative Emission Vent Valve Solenoid Circuit", description: "The vent valve solenoid circuit is open, shorted or unreadable.", severity: "medium" },
  "P0451": { title: "Evaporative Emission Pressure Sensor Range/Performance", description: "The fuel tank pressure sensor reading does not change as the system runs.", severity: "medium" },
  "P0452": { title: "Evaporative Emission Pressure Sensor Low Input", description: "The fuel tank pressure sensor reports a voltage below the valid range.", severity: "medium" },
  "P0453": { title: "Evaporative Emission Pressure Sensor High Input", description: "The fuel tank pressure sensor reports a voltage above the valid range.", severity: "medium" },
  "P0455": { title: "Evaporative Emission System Leak (Gross Leak)", description: "The EVAP system has a large vapour leak, often a missing or loose fuel cap.", severity: "low", causes: ["missing or loose fuel cap", "disconnected EVAP hose", "faulty vent valve"] },
  "P0456": { title: "Evaporative Emission System Leak (Very Small Leak)", description: "The EVAP system has a very small vapour leak, usually a seal or hose.", severity: "low" },
  "P0457": { title: "Evaporative Emission System Leak (Fuel Cap)", description: "The fuel cap is loose, missing or not sealing, so vapour escapes.", severity: "low" },
  "P0496": { title: "Evaporative Emission System High Purge Flow", description: "Purge flow is higher than commanded, which can make the engine run rough.", severity: "medium" },
  "P0497": { title: "Evaporative Emission System Low Purge Flow", description: "Purge flow is lower than commanded, so fuel vapour is not being burned.", severity: "medium" },

  // --- Speed, idle and charging (P05xx) ---
  "P0500": { title: "Vehicle Speed Sensor A Malfunction", description: "The computer gets no usable vehicle speed signal from the transmission.", severity: "medium" },
  "P0501": { title: "Vehicle Speed Sensor A Range/Performance", description: "The vehicle speed signal does not match engine speed and gearing.", severity: "medium" },
  "P0505": { title: "Idle Control System Malfunction", description: "The computer cannot hold a steady idle speed.", severity: "medium" },
  "P0506": { title: "Idle Control System RPM Lower Than Expected", description: "Idle speed sits below the target, so the engine may stall at stops.", severity: "medium" },
  "P0507": { title: "Idle Control System RPM Higher Than Expected", description: "Idle speed sits above the target, usually because of a vacuum leak.", severity: "medium" },
  "P0520": { title: "Engine Oil Pressure Sensor/Switch Circuit Malfunction", description: "The oil pressure sensor circuit is open, shorted or unreadable.", severity: "medium" },
  "P0521": { title: "Engine Oil Pressure Sensor/Switch Range/Performance", description: "Oil pressure readings do not match engine speed and temperature.", severity: "medium" },
  "P0522": { title: "Engine Oil Pressure Sensor Circuit Low Voltage", description: "The oil pressure sensor reports a lower voltage than the range allows.", severity: "medium" },
  "P0530": { title: "A/C Refrigerant Pressure Sensor A Circuit", description: "The air conditioning refrigerant pressure sensor signal is unusable.", severity: "medium" },
  "P0560": { title: "System Voltage Malfunction", description: "The voltage the computer sees is outside the range it can run on.", severity: "medium" },
  "P0562": { title: "System Voltage Low", description: "System voltage is too low, so modules may reset or behave erratically.", severity: "medium", causes: ["weak or failing alternator", "worn serpentine belt", "corroded battery terminals"] },
  "P0563": { title: "System Voltage High", description: "System voltage is too high, which can damage modules and bulbs.", severity: "medium" },
  "P0571": { title: "Brake Switch A Circuit Malfunction", description: "The brake pedal switch circuit disagrees with the other brake inputs.", severity: "medium" },
  "P0597": { title: "Thermostat Heater Control Circuit/Open", description: "The map-controlled thermostat heater circuit is open or unreadable.", severity: "medium" },

  // --- PCM, glow plug, fan (P06xx) ---
  "P0600": { title: "Serial Communication Link Malfunction", description: "The computer cannot communicate over its internal serial data link.", severity: "medium" },
  "P0601": { title: "Internal Control Module Memory Checksum Error", description: "The computer memory failed its checksum test, so the module may be faulty.", severity: "medium" },
  "P0602": { title: "Control Module Programming Error", description: "The computer has not been programmed correctly or programming was interrupted.", severity: "medium" },
  "P0603": { title: "Internal Control Module Keep Alive Memory Error", description: "The computer lost the memory it keeps when the ignition is switched off.", severity: "medium" },
  "P0605": { title: "Internal Control Module Read Only Memory Error", description: "The computer read-only memory failed its internal self test.", severity: "medium" },
  "P0606": { title: "PCM Processor Fault", description: "The engine computer processor failed its internal self test.", severity: "medium" },
  "P0607": { title: "Control Module Performance", description: "The engine computer is not responding to inputs within the expected time.", severity: "medium" },
  "P0620": { title: "Generator Control Circuit Malfunction", description: "The computer cannot control the alternator charging output.", severity: "medium" },
  "P0650": { title: "Malfunction Indicator Lamp Control Circuit", description: "The check engine light circuit is open or shorted, so the bulb may not work.", severity: "medium" },
  "P0685": { title: "ECM/PCM Power Relay Control Circuit/Open", description: "The main relay that powers the engine computer is not being switched on.", severity: "medium" },

  // --- Transmission and shift solenoids (P07xx) ---
  "P0700": { title: "Transmission Control System Malfunction", description: "The transmission computer stored a fault and asked the engine light to come on.", severity: "medium", causes: ["stored transmission control fault", "low transmission fluid", "faulty shift solenoid"] },
  "P0701": { title: "Transmission Control System Range/Performance", description: "The transmission control system is working outside its expected range.", severity: "medium" },
  "P0702": { title: "Transmission Control System Electrical", description: "The transmission control system has an electrical fault in its circuit.", severity: "medium" },
  "P0705": { title: "Transmission Range Sensor Circuit Malfunction", description: "The gear selector position sensor is not reporting a valid position.", severity: "medium" },
  "P0706": { title: "Transmission Range Sensor Circuit Range/Performance", description: "The gear selector position signal is erratic or does not match the gear.", severity: "medium" },
  "P0710": { title: "Transmission Fluid Temperature Sensor Circuit", description: "The transmission fluid temperature sensor circuit is open or shorted.", severity: "medium" },
  "P0715": { title: "Input/Turbine Speed Sensor Circuit Malfunction", description: "The transmission input speed sensor is not sending a usable signal.", severity: "medium" },
  "P0720": { title: "Output Speed Sensor Circuit Malfunction", description: "The transmission output speed sensor is not sending a usable signal.", severity: "medium" },
  "P0730": { title: "Incorrect Gear Ratio", description: "The transmission is running a different gear ratio than the one commanded.", severity: "medium" },
  "P0740": { title: "Torque Converter Clutch Circuit Malfunction", description: "The torque converter lock-up clutch circuit is open, shorted or unreadable.", severity: "medium" },
  "P0741": { title: "Torque Converter Clutch Circuit Performance/Stuck Off", description: "The lock-up clutch will not engage, so the engine revs without the car speeding up.", severity: "medium", causes: ["worn torque converter clutch", "low transmission fluid", "faulty lock-up solenoid"] },
  "P0742": { title: "Torque Converter Clutch Circuit Stuck On", description: "The lock-up clutch stays engaged, so the engine stalls or shudders at stops.", severity: "medium" },
  "P0750": { title: "Shift Solenoid A Malfunction", description: "The shift solenoid A circuit is open, shorted or drawing wrong current.", severity: "medium" },
  "P0751": { title: "Shift Solenoid A Performance/Stuck Off", description: "Shift solenoid A does not change the gear when it is commanded to.", severity: "medium" },
  "P0755": { title: "Shift Solenoid B Malfunction", description: "The shift solenoid B circuit is open, shorted or drawing wrong current.", severity: "medium" },
  "P0780": { title: "Shift Malfunction", description: "The transmission cannot complete a gear change within the expected time.", severity: "medium" },

  // --- Cooling system performance (P2181) ---
  "P2181": { title: "Cooling System Performance", description: "The cooling system does not hold the engine at its designed operating temperature.", severity: "medium", causes: ["stuck thermostat", "air pocket in cooling system", "faulty coolant temperature sensor"] },

  // --- ABS and brake system (C0xxx) ---
  "C0035": { title: "Left Front Wheel Speed Sensor Circuit", description: "The left front wheel speed sensor circuit is open or shorted.", severity: "high" },
  "C0036": { title: "Left Front Wheel Speed Sensor Range/Performance", description: "The left front wheel speed signal is erratic or drops out while driving.", severity: "high" },
  "C0040": { title: "Right Front Wheel Speed Sensor Circuit", description: "The right front wheel speed sensor circuit is open or shorted.", severity: "high" },
  "C0045": { title: "Left Rear Wheel Speed Sensor Circuit", description: "The left rear wheel speed sensor circuit is open or shorted.", severity: "high" },
  "C0050": { title: "Right Rear Wheel Speed Sensor Circuit", description: "The right rear wheel speed sensor circuit is open or shorted.", severity: "high" },
  "C0110": { title: "ABS Pump Motor Circuit Malfunction", description: "The ABS pump motor circuit is open, shorted or drawing wrong current.", severity: "high" },
  "C0121": { title: "ABS Valve Relay Circuit Malfunction", description: "The ABS valve relay circuit is open, shorted or unreadable.", severity: "high" },
  "C0161": { title: "ABS/TCS Brake Switch Circuit Malfunction", description: "The brake switch input the ABS module sees is not consistent.", severity: "high" },
  "C0265": { title: "Electronic Brake Control Module Relay Circuit", description: "The ABS control module power relay circuit is faulty.", severity: "high" },
  "C1201": { title: "Engine Control System Malfunction", description: "The ABS module received a fault report from the engine computer.", severity: "high", causes: ["fault stored in engine computer", "misfire or emissions fault", "read engine codes first"] },

  // --- Body and comfort (B1xxx) ---
  "B1000": { title: "ECU Malfunction", description: "The body control module reported an internal fault.", severity: "low" },
  "B1001": { title: "Option Configuration Error", description: "The body module is not configured for the options this vehicle has.", severity: "low" },
  "B1200": { title: "Climate Control Pushbutton Circuit Failure", description: "A climate control panel button circuit is open or shorted.", severity: "low" },
  "B1318": { title: "Battery Voltage Low", description: "Battery voltage dropped too low for the body module to work reliably.", severity: "low", causes: ["weak or aged battery", "failing alternator", "loose battery terminals"] },
  "B1342": { title: "ECU Internal Fault", description: "The body control module failed its own internal self test.", severity: "low" },
  "B1352": { title: "Ignition Key-In Circuit Failure", description: "The key-in-ignition switch circuit is open or shorted.", severity: "low" },

  // --- CAN bus and communication (U0xxx) ---
  "U0001": { title: "High Speed CAN Communication Bus", description: "The high speed CAN bus is not communicating at all.", severity: "high" },
  "U0002": { title: "High Speed CAN Communication Bus Performance", description: "The high speed CAN bus works but with errors and dropouts.", severity: "high" },
  "U0003": { title: "High Speed CAN Communication Bus (+) Open", description: "The CAN bus high wire is open somewhere in the network.", severity: "high" },
  "U0004": { title: "High Speed CAN Communication Bus (+) Low", description: "The CAN bus high wire is shorted to ground or to the low wire.", severity: "high" },
  "U0073": { title: "Control Module Communication Bus A Off", description: "A control module switched its own CAN bus off after too many errors.", severity: "high" },
  "U0100": { title: "Lost Communication With ECM/PCM A", description: "The other modules can no longer hear the engine computer on the bus.", severity: "high", causes: ["blown ECM power fuse", "damaged CAN wiring", "failed engine computer"] },
  "U0101": { title: "Lost Communication With TCM", description: "The other modules can no longer hear the transmission computer on the bus.", severity: "high" },
  "U0121": { title: "Lost Communication With ABS Control Module", description: "The other modules can no longer hear the ABS control module on the bus.", severity: "high" },
  "U0140": { title: "Lost Communication With Body Control Module", description: "The other modules can no longer hear the body control module on the bus.", severity: "high" },
  "U0155": { title: "Lost Communication With Instrument Panel Cluster", description: "The other modules can no longer hear the dashboard cluster on the bus.", severity: "high" },
};
