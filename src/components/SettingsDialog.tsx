import { useState } from "react"
import type { ReactElement } from "react"
import { Dialog } from "@/components/Dialog"

/**
 * Settings and stored data, behind the gear.
 *
 * Help explains; Settings acts. The list of converted datasets belongs here too, but it
 * wants the per-dataset name, size and date that the completion marker will carry, so it
 * arrives with that. What is here now is what would otherwise have no home at all once
 * the load dialog goes away: the storage figures, the escape hatch for reclaiming space,
 * and the diagnostics that used to sit in the top bar.
 */
export function SettingsDialog(props: {
  open: boolean
  onClose: () => void
  /** The file's name, as shown on Neuroglancer's own layer. */
  sourceName: string
  /** Where it came from, or null for a local file. */
  sourceUrl: string | null
  usage: number
  quota: number
  persisted: boolean
  /** Projected size of the conversion in flight, or null when nothing is pending. */
  projected: number | null
  /** Per-channel measurements and the post-ingest probe, one line each. */
  diagnostics: string[]
  warnings: string[]
  onClearAll: () => void
  clearing: boolean
}): ReactElement {
  // Deleting every converted volume can discard hours of work, so it takes two clicks.
  // A second dialog on top of this one would be worse than a button that changes its
  // mind for a moment.
  const [confirming, setConfirming] = useState(false)

  const remaining = props.quota - props.usage
  const overQuota = props.projected !== null && props.projected > remaining

  return (
    <Dialog
      open={props.open}
      title="Settings"
      onClose={() => {
        setConfirming(false)
        props.onClose()
      }}
    >
      {props.sourceName ? (
        <section className="settings-section">
          <h3>Source</h3>
          {/* The full URL, unabbreviated: the address bar has it percent-encoded among
              the other parameters, and the top bar deliberately does not repeat what
              Neuroglancer already shows as the layer name. */}
          <p className="settings-source">
            {props.sourceUrl ?? props.sourceName}
          </p>
          {props.sourceUrl ? null : (
            <p>
              Loaded from a local file, so this session has no shareable link.
            </p>
          )}
        </section>
      ) : null}

      <section className="settings-section">
        <h3>Storage</h3>
        <p>
          {formatBytes(props.usage)} of {formatBytes(props.quota)} used
          {props.persisted ? " · persisted" : " · not persisted"}
        </p>
        {props.projected !== null ? (
          <p
            className={overQuota ? "storage-warning" : undefined}
            role={overQuota ? "alert" : undefined}
          >
            This conversion needs about {formatBytes(props.projected)}
            {overQuota ? " — more than the space left" : ""}
          </p>
        ) : null}
        <button
          type="button"
          onClick={() => {
            if (confirming) {
              props.onClearAll()
              setConfirming(false)
            } else {
              setConfirming(true)
            }
          }}
          disabled={props.clearing}
          title="Delete every converted volume from this browser's storage"
        >
          {props.clearing
            ? "Deleting…"
            : confirming
              ? "Really delete everything?"
              : "Delete all cached data"}
        </button>
      </section>

      {props.warnings.length > 0 || props.diagnostics.length > 0 ? (
        <section className="settings-section">
          <h3>Diagnostics</h3>
          {/*
            Kept because the failure these describe is silent: a channel that decoded to
            zeros and a channel that is merely dim look identical in the viewer, and a
            pyramid level whose chunks 404 renders as black with no error anywhere.
          */}
          {props.warnings.length > 0 ? (
            <ul className="settings-warnings">
              {props.warnings.map((warning, index) => (
                <li key={index}>{warning}</li>
              ))}
            </ul>
          ) : null}
          {props.diagnostics.length > 0 ? (
            <ul className="settings-diagnostics">
              {props.diagnostics.map((line, index) => (
                <li key={index}>{line}</li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
    </Dialog>
  )
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  const exp = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1
  )
  const value = bytes / 1024 ** exp
  return `${exp === 0 ? value : value.toFixed(1)} ${units[exp]}`
}
