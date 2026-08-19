import { useId, useState } from "react"
import type { ChangeEvent, ReactElement } from "react"

export function SourcePicker(props: {
  onSelect: (src: File | string) => void
  disabled?: boolean
}): ReactElement {
  const fileInputId = useId()
  const urlInputId = useId()
  const [url, setUrl] = useState("")

  function handleFileChange(e: ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0]
    e.target.value = ""
    if (file) props.onSelect(file)
  }

  function handleLoadUrl(): void {
    const trimmed = url.trim()
    if (trimmed) props.onSelect(trimmed)
  }

  return (
    <div className="source-picker">
      <div className="field">
        <label htmlFor={fileInputId}>H5J file</label>
        <input
          id={fileInputId}
          type="file"
          accept=".h5j"
          disabled={props.disabled}
          onChange={handleFileChange}
        />
      </div>
      <div className="field field-row">
        <label htmlFor={urlInputId}>H5J URL</label>
        <input
          id={urlInputId}
          type="text"
          placeholder="https://example.org/data.h5j"
          value={url}
          disabled={props.disabled}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleLoadUrl()
          }}
        />
        <button
          type="button"
          disabled={props.disabled || url.trim().length === 0}
          onClick={handleLoadUrl}
        >
          Load
        </button>
      </div>
    </div>
  )
}
