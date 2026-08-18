import {
  CanStatusBits,
  encodeFrame,
  parseFrame,
  type DeviceInfo,
} from "../protocol/frame";
import { EventedTransport } from "./BleTransport";

/**
 * Synthetic 10 Hz stream through the real frame encoder/parser path.
 * Enable with `?mock` so the UI can be developed without hardware.
 */
export class MockTransport extends EventedTransport {
  readonly kind = "mock" as const;

  private timer: ReturnType<typeof setInterval> | null = null;
  private sequence = 0;
  private startedAt = 0;
  private rateMs = 100;

  async connect(): Promise<void> {
    this.emit("connection", "connecting");
    this.startedAt = performance.now();
    this.sequence = 0;

    const info: DeviceInfo = {
      firmware: "0.1.0-mock",
      protocol: 1,
      notifyIntervalMs: this.rateMs,
      frameSize: 20,
      simulated: true,
      signals: [
        { name: "rpm", bit: 0 },
        { name: "speed", bit: 1 },
        { name: "coolantTemp", bit: 2 },
        { name: "intakeTemp", bit: 3 },
        { name: "engineLoad", bit: 4 },
        { name: "throttle", bit: 5 },
        { name: "fuelLevel", bit: 6 },
        { name: "voltage", bit: 7 },
      ],
    };

    this.emit("deviceInfo", info);
    this.emit("connection", "connected");
    this.start();
  }

  async disconnect(): Promise<void> {
    this.stop();
    this.emit("connection", "disconnected");
  }

  async setNotifyRate(ms: number): Promise<void> {
    if (ms < 20 || ms > 2000) return;
    this.rateMs = ms;
    if (this.timer) {
      this.stop();
      this.start();
    }
  }

  private start(): void {
    this.timer = setInterval(() => this.tick(), this.rateMs);
  }

  private stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    const t = performance.now() - this.startedAt;
    const phase = ((t % 12000) / 12000) * Math.PI * 2;

    // Mirror firmware simulator formulas (obd_can.cpp simulateResponse).
    const rpm = Math.round(900 + 2600 * (0.5 + 0.5 * Math.sin(phase)));
    const speed = Math.round(60 + 50 * Math.sin(phase * 0.5));
    const loadRaw = 90 + 60 * Math.sin(phase);
    const thrRaw = 58 + 40 * Math.sin(phase);

    const bytes = encodeFrame({
      validMask: 0xff,
      rpm,
      speed: Math.max(0, Math.min(255, speed)),
      coolantTemp: 89,
      intakeTemp: 31,
      engineLoad: (loadRaw / 255) * 100,
      throttle: (thrRaw / 255) * 100,
      fuelLevel: (184 / 255) * 100,
      voltage: 14.1,
      timestamp: Math.floor(t),
      sequence: this.sequence++,
      canStatus:
        CanStatusBits.BUS_OK |
        CanStatusBits.SIMULATED |
        CanStatusBits.DISCOVERY_DONE,
      reserved: 0,
    });

    this.emit("frame", parseFrame(bytes));
  }
}
