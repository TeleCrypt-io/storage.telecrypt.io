// Buffer polyfill: matrix-js-sdk / matrix-encrypt-attachment call Buffer.from()
// directly (Node-ism), which does not exist in a browser. Must be wired up
// before anything from matrix-js-sdk runs.
import { Buffer } from "buffer";
(globalThis as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;

import { createRoot } from "react-dom/client";
import "./theme.css";
import "./index.css";
import App from "./App.tsx";
import { loadRuntimeSettings } from "./lib/buildConfig";

async function bootstrap(): Promise<void> {
  const root = document.getElementById("root")!;
  try {
    await loadRuntimeSettings();
  } catch (error) {
    // Do not render a login screen or accept a saved session until the
    // environment binding has been fetched and validated successfully.
    console.error("Storage runtime settings are invalid or unavailable", error);
    root.textContent = "Storage is unavailable: invalid or missing runtime settings.";
    return;
  }

  // Deliberately no <StrictMode>: it double-invokes effects in dev, which would
  // build two MatrixClients (two crypto stores, two sync loops) for one mount.
  createRoot(root).render(<App />);
}

void bootstrap();
