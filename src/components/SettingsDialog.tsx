import { useState } from "react"
import type { ReactElement } from "react"
import { Dialog } from "@/components/Dialog"
import { formatBytes } from "@/lib/bytes"
import {
  EXPIRY_DAYS,
  QUOTA_SAFETY_SHARE,
  STORAGE_LIMIT_GB_MAX,
  STORAGE_LIMIT_GB_MIN,
} from "@/lib/prefs"
import type { StorageLimit } from "@/lib/prefs"

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
  /** The conversion failure, if there was one. Null when nothing has gone wrong. */
  error: string | null
  onClearAll: () => void
  clearing: boolean
  /** The user's storage cap, in gigabytes. */
  limitGb: number
  onLimitGbChange: (limitGb: number) => void
  /** The limit actually in force, which the quota can hold below `limitGb`. */
  limit: StorageLimit
  /** Whether the user asked to keep converted volumes even when the disk is low. */
  keepWhenDiskLow: boolean
  onKeepWhenDiskLowChange: (keep: boolean) => void
}): ReactElement {
  // Deleting every converted volume can discard hours of work, so it takes two clicks.
  // A second dialog on top of this one would be worse than a button that changes its
  // mind for a moment.
  const [confirming, setConfirming] = useState(false)
  const [copied, setCopied] = useState(false)

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
      {/* First, and in its own section. The top bar's alert opens this dialog, and
          before this existed the error it was reporting appeared nowhere in here --
          only the warnings, which are routine. Full text, wrapped and selectable: the
          bar has to ellipsize it, and the part that names the fault is often the part
          that gets cut. */}
      {props.error ? (
        <section className="settings-section">
          <h3>Error</h3>
          <p className="settings-error" role="alert">
            {props.error}
          </p>
          {/* So a report arrives as text rather than a screenshot. Every question that
              followed the last one -- which browser, how full was storage, was it a
              private window -- is answered by this block, and none of it survives a
              photograph of a dialog. */}
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(
                [
                  `error: ${props.error}`,
                  props.sourceUrl ? `source: ${props.sourceUrl}` : "",
                  ...props.diagnostics,
                  ...props.warnings.map((w) => `warning: ${w}`),
                ]
                  .filter(Boolean)
                  .join("\n")
              )
              setCopied(true)
            }}
            title="Copy the error and everything known about this browser, for a bug report"
            aria-label="Copy diagnostics for a bug report"
          >
            {copied ? "Copied" : "Copy diagnostics"}
          </button>
        </section>
      ) : null}

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
          {formatBytes(props.usage)} used of a {formatBytes(props.limit.bytes)}{" "}
          limit
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
        {/* In gigabytes, because that is how anyone thinks about their disk. The browser's
            quota is not offered as a setting: nobody can see it, it moves as the disk
            fills, and each origin has its own. It still caps the limit quietly, and the
            note below says so when it does. */}
        <p className="settings-field">
          <label htmlFor="storage-limit">Keep at most</label>
          <input
            id="storage-limit"
            type="number"
            min={STORAGE_LIMIT_GB_MIN}
            max={STORAGE_LIMIT_GB_MAX}
            step={1}
            value={props.limitGb}
            onChange={(event) => {
              // A blanked field is mid-edit, not a request for the default.
              const value = Number(event.target.value)
              if (event.target.value !== "" && Number.isFinite(value)) {
                props.onLimitGbChange(value)
              }
            }}
            title="Discard the least recently opened volumes once converted data passes this size"
          />
          <span className="settings-field-unit">GB of converted volumes.</span>
        </p>
        {props.limit.reason === "quota" ? (
          <p className="settings-note storage-warning">
            Currently limited to {formatBytes(props.limit.bytes)} because disk space
            is low: this app never uses more than{" "}
            {Math.round(QUOTA_SAFETY_SHARE * 100)}% of the browser&apos;s quota (
            {formatBytes(props.quota)}), which shrinks as the disk fills.
          </p>
        ) : null}
        <p className="settings-note">
          Past the limit, the least recently opened volumes are discarded, and any not
          opened for {EXPIRY_DAYS} days are removed. A change takes effect the next
          time the app starts or converts a file.
        </p>

        {/* Opt-in, because persisted storage is exempt from the browser's own cleanup
            when the disk runs low -- and that cleanup is the only thing that ever clears
            an origin this app is no longer opened on. */}
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={props.keepWhenDiskLow}
            onChange={(event) =>
              props.onKeepWhenDiskLowChange(event.target.checked)
            }
          />
          Keep converted volumes even when the disk is low
        </label>
        <p className="settings-note">{persistenceNote(props)}</p>

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

/**
 * What the persistence setting has actually done. The browser decides, not the app, and
 * a grant cannot be withdrawn by the site -- so the checkbox alone would often be wrong.
 */
function persistenceNote(props: {
  keepWhenDiskLow: boolean
  persisted: boolean
}): string {
  if (props.keepWhenDiskLow) {
    return props.persisted
      ? "The browser has agreed not to clear them."
      : "The browser declined. Chrome decides this itself, based on how the site is " +
          "used -- for example, whether it is bookmarked or installed."
  }
  return props.persisted
    ? "The browser has already granted this site persistent storage, and a site " +
        "cannot give that up. To undo it, clear this site's data in Chrome's site " +
        "settings."
    : "Off: the browser may clear converted volumes if the disk gets low. They are " +
        "converted again the next time they are opened."
}
