import { MockTransport } from "./ble/MockTransport";
import type { BleTransport } from "./ble/BleTransport";
import { WebBleTransport } from "./ble/WebBleTransport";
import { VehicleStore } from "./state/VehicleStore";
import { App } from "./ui/App";
import "./styles.css";

const mockMode = new URLSearchParams(location.search).has("mock");

const store = new VehicleStore();
const transport: BleTransport = mockMode
  ? new MockTransport()
  : new WebBleTransport();

const root = document.querySelector("#app");
if (!root) {
  throw new Error("#app missing");
}

const app = new App(
  root as HTMLElement,
  store,
  {
    onConnect: () => void connect(),
    onDisconnect: () => void disconnect(),
  },
  mockMode,
);

transport.on("connection", (state, detail) => {
  app.setConnection(state, detail);
});

transport.on("deviceInfo", (info) => {
  store.setDeviceInfo(info);
});

transport.on("frame", (frame) => {
  store.pushFrame(frame);
});

async function connect(): Promise<void> {
  store.reset();
  try {
    await transport.connect();
  } catch {
    // Connection state already emitted by the transport.
  }
}

async function disconnect(): Promise<void> {
  await transport.disconnect();
}

if (mockMode) {
  void connect();
}
