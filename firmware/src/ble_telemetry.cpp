#include "ble_telemetry.h"

#include <NimBLEDevice.h>

#include "config.h"
#include "obd_can.h"
#include "obd_pids.h"
#include "vehicle_state.h"

namespace BleTelemetry {

static NimBLEServer* gServer = nullptr;
static NimBLECharacteristic* gTelemetry = nullptr;
static NimBLECharacteristic* gDeviceInfo = nullptr;
static NimBLECharacteristic* gStatus = nullptr;
static NimBLECharacteristic* gCommand = nullptr;

static bool gConnected = false;
static uint32_t gLastNotify = 0;
static uint16_t gNotifyIntervalMs = NOTIFY_INTERVAL_MS;

bool isConnected() { return gConnected; }

// ---------------------------------------------------------------------------
// Telemetry frame - 20 bytes, little-endian.
//
// 20 bytes is the payload that fits in the default 23-byte ATT MTU. iOS
// normally negotiates far more, but sizing to the guaranteed minimum means the
// frame always arrives as a single atomic notification: no fragmentation, no
// reassembly, no partial-frame edge cases.
//
//  off  size  type  field
//   0    1    u8    version
//   1    1    u8    validMask       bit n = signal n is fresh
//   2    2    u16   rpm
//   4    1    u8    speed           km/h
//   5    1    i8    coolantTemp     degC
//   6    1    i8    intakeTemp      degC
//   7    1    u8    engineLoad      percent x 2
//   8    1    u8    throttle        percent x 2
//   9    1    u8    fuelLevel       percent x 2
//  10    2    u16   voltage         millivolts
//  12    4    u32   timestamp       device millis()
//  16    2    u16   sequence        wrapping counter
//  18    1    u8    canStatus
//  19    1    u8    reserved        room for gear, oil temp, etc.
// ---------------------------------------------------------------------------

static const size_t kFrameSize = 20;

static inline void put16(uint8_t* b, size_t off, uint16_t v) {
  b[off] = v & 0xFF;
  b[off + 1] = (v >> 8) & 0xFF;
}

static inline void put32(uint8_t* b, size_t off, uint32_t v) {
  b[off] = v & 0xFF;
  b[off + 1] = (v >> 8) & 0xFF;
  b[off + 2] = (v >> 16) & 0xFF;
  b[off + 3] = (v >> 24) & 0xFF;
}

static inline uint8_t pct2(float p) {
  if (p < 0) p = 0;
  if (p > 127.5f) p = 127.5f;
  return (uint8_t)(p * 2.0f + 0.5f);
}

static inline int8_t clampTemp(int16_t t) {
  if (t < -128) return -128;
  if (t > 127) return 127;
  return (int8_t)t;
}

static void buildFrame(uint8_t* b) {
  memset(b, 0, kFrameSize);
  b[0] = PROTOCOL_VERSION;
  b[1] = gVehicle.validMask();
  put16(b, 2, gVehicle.rpm);
  b[4] = gVehicle.speed;
  b[5] = (uint8_t)clampTemp(gVehicle.coolantTemp);
  b[6] = (uint8_t)clampTemp(gVehicle.intakeTemp);
  b[7] = pct2(gVehicle.engineLoad);
  b[8] = pct2(gVehicle.throttle);
  b[9] = pct2(gVehicle.fuelLevel);
  put16(b, 10, (uint16_t)(gVehicle.voltage * 1000.0f));
  put32(b, 12, millis());
  put16(b, 16, gVehicle.sequence);
  b[18] = gVehicle.canStatus;
  b[19] = 0;  // reserved
}

// ---------------------------------------------------------------------------
// Device info - read once on connect. Tells the frontend which gauges are
// worth rendering, so an unsupported PID becomes a missing gauge rather than
// a permanently blank one.
// ---------------------------------------------------------------------------

static String buildDeviceInfoJson() {
  String s = "{\"firmware\":\"" FIRMWARE_VERSION "\",\"protocol\":";
  s += PROTOCOL_VERSION;
  s += ",\"notifyIntervalMs\":";
  s += gNotifyIntervalMs;
  s += ",\"frameSize\":";
  s += kFrameSize;
  s += ",\"simulated\":";
  s += (gVehicle.canStatus & CANST_SIMULATED) ? "true" : "false";
  s += ",\"signals\":[";
  bool first = true;
  for (uint8_t i = 0; i < kPidCount; i++) {
    if (!ObdCan::isSupported(kPidTable[i].pid)) continue;
    if (!first) s += ",";
    first = false;
    s += "{\"name\":\"";
    s += kPidTable[i].name;
    s += "\",\"bit\":";
    s += (int)kPidTable[i].signal;
    s += "}";
  }
  s += "]}";
  return s;
}

// ---------------------------------------------------------------------------
// Callbacks
// ---------------------------------------------------------------------------

class ServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer* s, NimBLEConnInfo& info) override {
    gConnected = true;

    // Apple rejects connection parameter requests outside its published
    // bounds, so ask for something inside them: 15-30 ms interval, 4 s timeout.
    s->updateConnParams(info.getConnHandle(), BLE_CONN_MIN_INTERVAL,
                        BLE_CONN_MAX_INTERVAL, BLE_CONN_LATENCY,
                        BLE_CONN_TIMEOUT);

    gDeviceInfo->setValue(buildDeviceInfoJson());
#if SERIAL_DEBUG
    Serial.println(F("[ble] client connected"));
#endif
  }

  void onDisconnect(NimBLEServer* s, NimBLEConnInfo& info, int reason) override {
    gConnected = false;
#if SERIAL_DEBUG
    Serial.printf("[ble] client disconnected (reason %d)\n", reason);
#endif
    NimBLEDevice::startAdvertising();
  }
};

class CommandCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* c, NimBLEConnInfo& info) override {
    std::string v = c->getValue();
#if SERIAL_DEBUG
    Serial.printf("[ble] command: %s\n", v.c_str());
#endif
    // Minimal command surface for now: {"rate":50} adjusts the notify period.
    int idx = v.find("\"rate\"");
    if (idx >= 0) {
      int colon = v.find(':', idx);
      if (colon >= 0) {
        int rate = atoi(v.c_str() + colon + 1);
        if (rate >= 20 && rate <= 2000) gNotifyIntervalMs = rate;
      }
    }
  }
};

// ---------------------------------------------------------------------------

void begin() {
  NimBLEDevice::init(BLE_DEVICE_NAME);
  NimBLEDevice::setMTU(185);
  NimBLEDevice::setPower(ESP_PWR_LVL_P9);

  gServer = NimBLEDevice::createServer();
  gServer->setCallbacks(new ServerCallbacks());

  NimBLEService* svc = gServer->createService(SVC_OBD_UUID);

  gTelemetry = svc->createCharacteristic(
      CHR_TELEMETRY_UUID, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);

  gDeviceInfo = svc->createCharacteristic(CHR_DEVICEINFO_UUID,
                                          NIMBLE_PROPERTY::READ);

  gCommand = svc->createCharacteristic(
      CHR_COMMAND_UUID,
      NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR);
  gCommand->setCallbacks(new CommandCallbacks());

  gStatus = svc->createCharacteristic(CHR_STATUS_UUID, NIMBLE_PROPERTY::NOTIFY);

  svc->start();

  // The service UUID must be in the advertising packet: Web Bluetooth's
  // service filter only matches UUIDs that are actually advertised. A 128-bit
  // UUID uses 18 of the 31 available bytes, so the name goes in the scan
  // response rather than competing for room in the primary packet.
  NimBLEAdvertising* adv = NimBLEDevice::getAdvertising();
  adv->addServiceUUID(SVC_OBD_UUID);
  adv->setName(BLE_DEVICE_NAME);
  adv->enableScanResponse(true);
  NimBLEDevice::startAdvertising();

#if SERIAL_DEBUG
  Serial.printf("[ble] advertising as %s\n", BLE_DEVICE_NAME);
#endif
}

void publishStatus(const char* json) {
  if (!gConnected || !gStatus) return;
  gStatus->setValue((uint8_t*)json, strlen(json));
  gStatus->notify();
}

void tick() {
  if (!gConnected) return;
  if (millis() - gLastNotify < gNotifyIntervalMs) return;
  gLastNotify = millis();

  gVehicle.sequence++;

  uint8_t frame[kFrameSize];
  buildFrame(frame);

  // Notifications fire on a fixed timer rather than per decoded PID, so a
  // chatty bus cannot flood the BLE link.
  gTelemetry->setValue(frame, kFrameSize);
  gTelemetry->notify();
}

}  // namespace BleTelemetry
