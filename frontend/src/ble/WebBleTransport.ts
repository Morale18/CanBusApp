import {
  parseDeviceInfo,
  parseFrame,
  type DeviceInfo,
} from "../protocol/frame";
import {
  CHR_COMMAND_UUID,
  CHR_DEVICEINFO_UUID,
  CHR_STATUS_UUID,
  CHR_TELEMETRY_UUID,
  SVC_OBD_UUID,
} from "../protocol/uuids";
import { EventedTransport } from "./BleTransport";

declare global {
  interface Navigator {
    bluetooth?: Bluetooth;
  }
}

interface Bluetooth {
  requestDevice(options: RequestDeviceOptions): Promise<BluetoothDevice>;
}

interface RequestDeviceOptions {
  filters?: Array<{ services?: string[]; name?: string; namePrefix?: string }>;
  optionalServices?: string[];
  acceptAllDevices?: boolean;
}

interface BluetoothDevice extends EventTarget {
  readonly name?: string;
  readonly gatt?: BluetoothRemoteGATTServer;
}

interface BluetoothRemoteGATTServer {
  readonly connected: boolean;
  connect(): Promise<BluetoothRemoteGATTServer>;
  disconnect(): void;
  getPrimaryService(service: string): Promise<BluetoothRemoteGATTService>;
}

interface BluetoothRemoteGATTService {
  getCharacteristic(
    characteristic: string,
  ): Promise<BluetoothRemoteGATTCharacteristic>;
}

interface BluetoothRemoteGATTCharacteristic extends EventTarget {
  readonly value?: DataView;
  startNotifications(): Promise<BluetoothRemoteGATTCharacteristic>;
  stopNotifications(): Promise<BluetoothRemoteGATTCharacteristic>;
  readValue(): Promise<DataView>;
  writeValue(value: BufferSource): Promise<void>;
  writeValueWithoutResponse?(value: BufferSource): Promise<void>;
}

/**
 * Chrome desktop + Bluefy (iOS) Web Bluetooth transport.
 * Safari / Chrome-on-iOS do not implement navigator.bluetooth.
 */
export class WebBleTransport extends EventedTransport {
  readonly kind = "web" as const;

  private device: BluetoothDevice | null = null;
  private commandChar: BluetoothRemoteGATTCharacteristic | null = null;
  private telemetryChar: BluetoothRemoteGATTCharacteristic | null = null;
  private statusChar: BluetoothRemoteGATTCharacteristic | null = null;

  private readonly onDisconnected = () => {
    this.cleanupListeners();
    this.emit("connection", "disconnected");
  };

  private readonly onTelemetry = (event: Event) => {
    const target = event.target as BluetoothRemoteGATTCharacteristic;
    const value = target.value;
    if (!value) return;
    try {
      this.emit("frame", parseFrame(value));
    } catch (err) {
      console.warn("[ble] bad telemetry frame", err);
    }
  };

  private readonly onStatus = (event: Event) => {
    const target = event.target as BluetoothRemoteGATTCharacteristic;
    const value = target.value;
    if (!value) return;
    const text = new TextDecoder().decode(value);
    this.emit("status", text);
  };

  static isSupported(): boolean {
    return typeof navigator !== "undefined" && !!navigator.bluetooth;
  }

  async connect(): Promise<void> {
    if (!WebBleTransport.isSupported()) {
      this.emit(
        "connection",
        "error",
        "Web Bluetooth is unavailable. Use desktop Chrome, or Bluefy on iPhone.",
      );
      throw new Error("Web Bluetooth unavailable");
    }

    this.emit("connection", "connecting");

    try {
      this.device = await navigator.bluetooth!.requestDevice({
        filters: [{ services: [SVC_OBD_UUID] }],
        optionalServices: [SVC_OBD_UUID],
      });

      this.device.addEventListener("gattserverdisconnected", this.onDisconnected);

      const server = await this.device.gatt!.connect();
      const service = await server.getPrimaryService(SVC_OBD_UUID);

      this.telemetryChar = await service.getCharacteristic(CHR_TELEMETRY_UUID);
      const deviceInfoChar = await service.getCharacteristic(CHR_DEVICEINFO_UUID);
      this.commandChar = await service.getCharacteristic(CHR_COMMAND_UUID);
      this.statusChar = await service.getCharacteristic(CHR_STATUS_UUID);

      const infoBytes = await deviceInfoChar.readValue();
      const infoJson = new TextDecoder().decode(infoBytes);
      let info: DeviceInfo;
      try {
        info = parseDeviceInfo(infoJson);
      } catch {
        info = {
          firmware: "unknown",
          protocol: 1,
          notifyIntervalMs: 100,
          frameSize: 20,
          simulated: false,
          signals: [],
        };
      }
      this.emit("deviceInfo", info);

      this.telemetryChar.addEventListener(
        "characteristicvaluechanged",
        this.onTelemetry,
      );
      await this.telemetryChar.startNotifications();

      this.statusChar.addEventListener(
        "characteristicvaluechanged",
        this.onStatus,
      );
      await this.statusChar.startNotifications();

      this.emit("connection", "connected");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.cleanupListeners();
      this.emit("connection", "error", message);
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    this.cleanupListeners();
    if (this.device?.gatt?.connected) {
      this.device.gatt.disconnect();
    }
    this.device = null;
    this.emit("connection", "disconnected");
  }

  async setNotifyRate(ms: number): Promise<void> {
    if (!this.commandChar) return;
    if (ms < 20 || ms > 2000) return;
    const payload = new TextEncoder().encode(JSON.stringify({ rate: ms }));
    if (this.commandChar.writeValueWithoutResponse) {
      await this.commandChar.writeValueWithoutResponse(payload);
    } else {
      await this.commandChar.writeValue(payload);
    }
  }

  private cleanupListeners(): void {
    this.telemetryChar?.removeEventListener(
      "characteristicvaluechanged",
      this.onTelemetry,
    );
    this.statusChar?.removeEventListener(
      "characteristicvaluechanged",
      this.onStatus,
    );
    this.device?.removeEventListener(
      "gattserverdisconnected",
      this.onDisconnected,
    );
    this.telemetryChar = null;
    this.statusChar = null;
    this.commandChar = null;
  }
}
