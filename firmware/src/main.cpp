// ---------------------------------------------------------------------------
// ESP32 OBD-II -> BLE bridge
//
// Reads OBD-II PIDs from an MCP2515 and publishes them over BLE as a compact
// 20-byte telemetry frame at 10 Hz.
//
// Libraries required (Arduino Library Manager):
//   - NimBLE-Arduino 2.x   (h2zero)
//   - MCP_CAN_lib          (coryjfowler)  - only when USE_SIMULATOR is 0
//
// NimBLE 2.x is assumed. On 1.4.x the callback signatures differ:
// onConnect(NimBLEServer*) with no NimBLEConnInfo, and setScanResponse()
// in place of enableScanResponse().
//
// Set USE_SIMULATOR to 1 in config.h to run with no CAN hardware attached.
// ---------------------------------------------------------------------------

#include <Arduino.h>

#include "ble_telemetry.h"
#include "config.h"
#include "obd_can.h"
#include "vehicle_state.h"

VehicleState gVehicle;

static uint32_t gLastPrint = 0;

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println();
  Serial.println(F("=== ESP32 OBD-II BLE bridge ==="));

#if USE_SIMULATOR
  Serial.println(F("[boot] SIMULATOR MODE - no CAN hardware in use"));
#endif

  if (!ObdCan::begin()) {
    Serial.println(F("[boot] MCP2515 init failed - check wiring and crystal"));
    // Keep going: BLE still comes up, so the link can be debugged without CAN.
  }

  BleTelemetry::begin();
  Serial.println(F("[boot] ready"));
}

void loop() {
  ObdCan::tick();
  BleTelemetry::tick();

#if SERIAL_DEBUG
  if (millis() - gLastPrint > 1000) {
    gLastPrint = millis();
    Serial.printf(
        "rpm=%u speed=%u coolant=%d intake=%d load=%.1f thr=%.1f fuel=%.1f "
        "volt=%.2f valid=0x%02X %s\n",
        gVehicle.rpm, gVehicle.speed, gVehicle.coolantTemp, gVehicle.intakeTemp,
        gVehicle.engineLoad, gVehicle.throttle, gVehicle.fuelLevel,
        gVehicle.voltage, gVehicle.validMask(),
        BleTelemetry::isConnected() ? "[BLE connected]" : "[advertising]");
  }
#endif
}
