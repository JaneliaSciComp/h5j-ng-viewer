import { useState } from "react"
import type { ReactElement } from "react"
import { Dialog } from "@/components/Dialog"
import { formatBytes } from "@/lib/bytes"
import {
  EVICTION_PERCENT_MAX,
  EVICTION_PERCENT_MIN,
  storageBudget,
} from "@/lib/prefs"

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
  /** How full storage may get before old volumes are discarded, 5..100. */
  evictionPercent: number
  onEvictionPercentChange: (percent: number) => void
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
        {/* A ceiling on how much of the browser's quota this app will occupy. Below
            100 by default: the quota is a share of one disk that every other site is
            drawing on too, and filling all of it is antisocial even where the browser
            permits it. Low values are also the quickest way to exercise eviction
            deliberately rather than waiting for a disk to fill. */}
        <p className="settings-field">
          <label htmlFor="eviction-percent">Use up to</label>
          <input
            id="eviction-percent"
            type="number"
            min={EVICTION_PERCENT_MIN}
            max={EVICTION_PERCENT_MAX}
            step={5}
            value={props.evictionPercent}
            onChange={(event) =>
              props.onEvictionPercentChange(Number(event.target.value))
            }
            title="Discard the least recently used volumes once storage passes this share of the browser's quota"
          />
          {/* The unit belongs to the number, so it must not be able to wrap away from
              it -- "Use up to 80" on one line and "% of the quota" on the next reads as
              two thoughts. The sentence that follows is a separate thought and gets its
              own line. */}
          <span className="settings-field-unit">
            % of the quota (
            {formatBytes(storageBudget(props.quota, props.evictionPercent))}).
          </span>
        </p>
        <p className="settings-note">
          Past this, the least recently used volumes are discarded.
        </p>

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
