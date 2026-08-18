#pragma once
#include <Arduino.h>

// ---------------------------------------------------------------------------
// Build options
// ---------------------------------------------------------------------------

// 1 = generate synthetic vehicle data, no CAN hardware needed (bench testing).
// 0 = talk to the real MCP2515 / car.
#define USE_SIMULATOR 0

// Print decoded values to Serial as well as BLE.
#define SERIAL_DEBUG 1

// ---------------------------------------------------------------------------
// Hardware
// ---------------------------------------------------------------------------

#define CAN_CS_PIN 5
#define CAN_INT_PIN 4  // MCP2515 INT -> RTC-capable GPIO (used later for wake-on-CAN)

#define CAN_SPEED CAN_500KBPS  // 2022 Corolla: ISO 15765-4, 500 kbps, 11-bit
#define CAN_CRYSTAL MCP_8MHZ   // change to MCP_16MHZ if your board has a 16 MHz can

// OBD-II addressing.
// 0x7DF = functional broadcast (matches the known-working Arduino sketch).
// Some ECUs answer discovery / Mode 01 more reliably here than on 0x7E0.
#define OBD_REQUEST_ID 0x7DF
#define OBD_RESPONSE_ID_MIN 0x7E8
#define OBD_RESPONSE_ID_MAX 0x7EF

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

#define PID_RESPONSE_TIMEOUT_MS 60   // give up on a request after this long
#define PID_GAP_MS 5                 // minimum spacing between requests
#define NOTIFY_INTERVAL_MS 100       // 10 Hz BLE telemetry
#define SIGNAL_STALE_MS 2000         // a value older than this is marked invalid
#define BUS_IDLE_SLEEP_MS 30000      // no valid response this long => ignition off

// ---------------------------------------------------------------------------
// BLE identity
// ---------------------------------------------------------------------------

// Bump the suffix whenever you change the GATT table during development.
// iOS caches the service/characteristic layout aggressively and will keep
// serving the stale one; a new device name sidesteps the cache.
#define BLE_DEVICE_NAME "OBD2-ESP32-v1"

#define FIRMWARE_VERSION "0.1.0"
#define PROTOCOL_VERSION 1

// ---------------------------------------------------------------------------
// GATT UUIDs
//
// Random 128-bit UUIDs. There is no SIG-assigned 16-bit UUID for "OBD-II
// telemetry", so a custom base is required. The 00/01/02/03/04 pattern is
// purely for human readability - only the full 128 bits are significant, and
// these must match the frontend byte-for-byte or the characteristics simply
// will not be found.
//
// Web Bluetooth requires lowercase UUID strings on the frontend side.
// ---------------------------------------------------------------------------

#define SVC_OBD_UUID "8f2a1c00-9d3b-4b7e-a1f6-2c5d0e7b4a10"
#define CHR_TELEMETRY_UUID "8f2a1c01-9d3b-4b7e-a1f6-2c5d0e7b4a10"  // notify + read
#define CHR_DEVICEINFO_UUID "8f2a1c02-9d3b-4b7e-a1f6-2c5d0e7b4a10" // read (JSON)
#define CHR_COMMAND_UUID "8f2a1c03-9d3b-4b7e-a1f6-2c5d0e7b4a10"    // write (JSON)
#define CHR_STATUS_UUID "8f2a1c04-9d3b-4b7e-a1f6-2c5d0e7b4a10"     // notify (JSON)

// ---------------------------------------------------------------------------
// Apple connection parameter constraints
//
// Apple's Accessory Design Guidelines reject connection parameter requests
// outside these bounds. Interval units are 1.25 ms, timeout units are 10 ms.
// 12 * 1.25 = 15 ms min, 24 * 1.25 = 30 ms max, 4 s supervision timeout.
// ---------------------------------------------------------------------------

#define BLE_CONN_MIN_INTERVAL 12
#define BLE_CONN_MAX_INTERVAL 24
#define BLE_CONN_LATENCY 0
#define BLE_CONN_TIMEOUT 400
