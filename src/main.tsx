import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "@/App"
import "@/index.css"

/**
 * Everything this viewer needs -- service workers, OPFS, SharedArrayBuffer -- is gated
 * behind a secure context, and browsers report the absence by simply not defining the
 * API. Checking in this order means the message names the actual cause instead of
 * blaming the browser, because the most common cause by far is a plain-HTTP origin
 * that is not `localhost`.
 */
function unsupportedReason(): string | null {
  if (!window.isSecureContext) {
    return (
      `${location.origin} is not a secure context, so the browser hides service ` +
      `workers, OPFS and SharedArrayBuffer -- all of which this viewer needs. ` +
      `Only https:// and http://localhost qualify; a bare IP over http does not. ` +
      `Either browse via http://localhost (an "ssh -L 3000:localhost:3000" tunnel ` +
      `keeps the origin on localhost), or serve over HTTPS with "pnpm dev:https".`
    )
  }
  if (!("serviceWorker" in navigator)) {
    return (
      "This browser does not expose navigator.serviceWorker, which is the only way " +
      "to feed Neuroglancer local data. Note that Firefox disables service workers " +
      "in Private Browsing windows."
    )
  }
  if (typeof navigator.storage?.getDirectory !== "function") {
    return (
      "This browser has no OPFS support (navigator.storage.getDirectory), which is " +
      "where converted volumes are stored. Chrome 108+, Edge 108+ or Firefox 111+ " +
      "are required."
    )
  }
  if (typeof SharedArrayBuffer === "undefined") {
    return (
      "SharedArrayBuffer is unavailable, so the H.265 decoder cannot start. The " +
      "server must send Cross-Origin-Opener-Policy: same-origin and " +
      "Cross-Origin-Embedder-Policy: require-corp on every response."
    )
  }
  return null
}

// Neuroglancer reads data only over http/https/gs/s3, so a service worker acting as a
// virtual origin is the only way to feed it data from OPFS without patching it. The
// worker must be controlling this page BEFORE the viewer mounts, because Neuroglancer's
// chunk fetches come from a dedicated worker whose interception depends on this client
// being controlled.
async function registerServiceWorker(): Promise<void> {
  const reason = unsupportedReason()
  if (reason) throw new Error(reason)

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
