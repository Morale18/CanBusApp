# ESP32 OBD-II → BLE → TypeScript

Proof of concept for a 2022 Corolla Hatchback XSE (6MT). ESP32 + MCP2515 reads
OBD-II PIDs and publishes them over BLE; a TypeScript page subscribes and
displays them. No backend, no Wi-Fi.

```
CanBusApp/
├── firmware/          PlatformIO (ESP32 + NimBLE + MCP2515)
│   ├── platformio.ini
│   ├── include/       config, vehicle_state, obd_pids, headers
│   └── src/           main, obd_can, ble_telemetry
└── frontend/          Vite + TypeScript Web Bluetooth dashboard
    └── src/
        ├── protocol/  20-byte frame parser + UUIDs
        ├── ble/       WebBle + Mock transports
        ├── state/     VehicleStore + ring buffers
        └── ui/        Dashboard
```

## Run it without a car or an ESP32

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173/?mock` — synthetic data at 10 Hz through the real
parser. Drop the `?mock` to talk to actual hardware.

## Firmware

Open `firmware/` in VS Code or Cursor with the **PlatformIO** extension. It
handles the ESP32 toolchain and libraries; `platformio.ini` pins:

- **NimBLE-Arduino 2.x** (h2zero)
- **MCP_CAN_lib** (coryjfowler) — only needed when `USE_SIMULATOR` is `0`

Build / upload / monitor via the PlatformIO status bar, or:

```bash
cd firmware
pio run
pio run -t upload
pio device monitor
```

`include/config.h` has `USE_SIMULATOR 1` by default: the ESP32 fabricates
plausible vehicle data so the BLE path can be proven on a desk. Set it to `0`
once the link works and you are ready to plug into the car.

### Wiring (MCP2515)

| MCP2515 | ESP32 |
|---------|-------|
| CS      | GPIO 5 |
| INT     | GPIO 4 |
| SCK/MOSI/MISO | SPI defaults |
| Crystal | 8 MHz (`MCP_8MHZ`) — change to `MCP_16MHZ` if needed |

## Test order

1. `USE_SIMULATOR 1`, flash, open the frontend in **desktop Chrome**. Prove BLE.
2. Deploy the frontend to any HTTPS static host, open in **Bluefy** on iPhone.
3. `USE_SIMULATOR 0`, plug into the Corolla.

Step 1 before step 3, always.

## iPhone

Safari has no Web Bluetooth. Use **Bluefy** from the App Store. The page needs
a secure context (HTTPS) — GitHub Pages, Netlify, or Cloudflare Pages all work.

**GATT caching:** bump `BLE_DEVICE_NAME` in `config.h` after GATT changes, or
forget the device in Settings → Bluetooth.

## Protocol

### Service and characteristics

| Role | UUID | Properties |
|------|------|------------|
| Service | `8f2a1c00-9d3b-4b7e-a1f6-2c5d0e7b4a10` | — |
| Telemetry | `8f2a1c01-…` | Notify + Read |
| Device info | `8f2a1c02-…` | Read (JSON) |
| Command | `8f2a1c03-…` | Write (JSON) |
| Status | `8f2a1c04-…` | Notify (JSON) |

UUIDs must match between `firmware/include/config.h` and
`frontend/src/protocol/uuids.ts` (lowercase on the web side).

### Telemetry frame — 20 bytes, little-endian

| Off | Size | Type | Field | Encoding |
|-----|------|------|-------|----------|
| 0 | 1 | u8 | version | `0x01` |
| 1 | 1 | u8 | validMask | bit *n* = signal *n* is fresh |
| 2 | 2 | u16 | rpm | rev/min |
| 4 | 1 | u8 | speed | km/h |
| 5 | 1 | i8 | coolantTemp | °C |
| 6 | 1 | i8 | intakeTemp | °C |
| 7 | 1 | u8 | engineLoad | % × 2 |
| 8 | 1 | u8 | throttle | % × 2 |
| 9 | 1 | u8 | fuelLevel | % × 2 |
| 10 | 2 | u16 | voltage | millivolts |
| 12 | 4 | u32 | timestamp | device `millis()` |
| 16 | 2 | u16 | sequence | wrapping counter |
| 18 | 1 | u8 | canStatus | flags |
| 19 | 1 | u8 | reserved | future |

`validMask` bit order: rpm, speed, coolant, intake, load, throttle, fuel,
voltage. Append only — never reorder.

## Adding a PID

1. Add a decoder + row in `firmware/include/obd_pids.h` (`kPidTable`).
2. If it must reach the UI: claim a bit in `SignalId`, use the reserved byte (or
   bump `PROTOCOL_VERSION`), and mirror the change in `frontend/src/protocol/frame.ts`.

## Next

- Gear indicator from RPM/speed ratio (manual ratios cluster cleanly).
- Deep sleep + wake-on-CAN via MCP2515 INT.
- On a permanent PCB: use an SN65HVD230 / TJA1051T/3 / MCP2562FD — typical
  TJA1050 breakouts are 5 V-only and defeat deep sleep.
