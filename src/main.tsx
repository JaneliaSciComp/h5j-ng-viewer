import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "@/App"
import "@/index.css"

// Neuroglancer reads data only over http/https/gs/s3, so a service worker acting as a
// virtual origin is the only way to feed it data from OPFS without patching it. The
// worker must be controlling this page BEFORE the viewer mounts, because Neuroglancer's
// chunk fetches come from a dedicated worker whose interception depends on this client
// being controlled.
async function registerServiceWorker(): Promise<void> {
  if (!("serviceWorker" in navigator)) {
    throw new Error(
      "This browser has no service worker support, which this viewer requires."
    )
  }
  await navigator.serviceWorker.register("/sw.js", { scope: "/" })
  await navigator.serviceWorker.ready
  if (!navigator.serviceWorker.controller) {
    // The very first visit loads uncontrolled. One reload is the standard remedy and
    // is cheap here because nothing has been ingested yet.
    location.reload()
  }
}

const root = createRoot(document.getElementById("root")!)

registerServiceWorker().then(
  () =>
    root.render(
      <StrictMode>
        <App />
      </StrictMode>
    ),
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    root.render(
      <div className="fatal" role="alert">
        <h1>Cannot start</h1>
        <p>{message}</p>
      </div>
    )
  }
)
