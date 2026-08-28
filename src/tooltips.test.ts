// Every control carries a one-line tooltip. That is a stated requirement, and it is the
// kind that rots silently: a new button looks fine, works fine, and simply never explains
// itself. A source scan catches it without needing a DOM, in the same spirit as the
// className/CSS check.

import { readFileSync, readdirSync } from "node:fs"
import { describe, expect, it } from "vitest"

function sourceFiles(): string[] {
  return [
    "src/App.tsx",
    ...readdirSync("src/components")
      .filter((name) => name.endsWith(".tsx"))
      .map((name) => `src/components/${name}`),
  ]
}

/**
 * Each `<button` element in a file, as the text from `<button` to the end of its opening
 * tag. Brace depth is tracked so a `>` inside a handler does not end the tag early;
 * quotes are only significant at depth 0, i.e. in attribute position, because inside a
 * handler an apostrophe is far more likely to be prose than a string delimiter.
 */
function buttonTags(source: string): string[] {
  const tags: string[] = []
  let at = source.indexOf("<button")
  while (at !== -1) {
    let depth = 0
    let quote: string | null = null
    let end = -1
    for (let i = at; i < source.length; i++) {
      const char = source[i]
      if (quote) {
        if (char === quote) quote = null
      } else if (depth === 0 && (char === '"' || char === "'")) {
        quote = char
      } else if (char === "{") {
        depth++
      } else if (char === "}") {
        depth--
      } else if (char === ">" && depth === 0) {
        end = i
        break
      }
    }
    // Never fail to advance: an unparseable tag must not hang the suite.
    if (end === -1) break
    tags.push(source.slice(at, end + 1))
    at = source.indexOf("<button", end + 1)
  }
  return tags
}

describe("every button explains itself", () => {
  it("has a title on each button", () => {
    const missing: string[] = []
    for (const path of sourceFiles()) {
      for (const tag of buttonTags(readFileSync(path, "utf8"))) {
        if (!/\btitle=/.test(tag)) {
          missing.push(`${path}: ${tag.replace(/\s+/g, " ").slice(0, 70)}…`)
        }
      }
    }
    expect(missing).toEqual([])
  })

  it("has an accessible name on each button", () => {
    // Either an explicit aria-label, or text content the parser can see. A button whose
    // whole content is an icon needs the label; one reading "Clear cached data" does not.
    const missing: string[] = []
    for (const path of sourceFiles()) {
      const source = readFileSync(path, "utf8")
      for (const tag of buttonTags(source)) {
        if (/\baria-label=/.test(tag)) continue
        const after = source.slice(source.indexOf(tag) + tag.length)
        const content = after.slice(0, after.indexOf("</button>"))
        // Anything that is not markup or whitespace counts as a visible name.
        const text = content.replace(/<[^>]*>/g, "").trim()
        if (!text) {
          missing.push(`${path}: ${tag.replace(/\s+/g, " ").slice(0, 70)}…`)
        }
      }
    }
    expect(missing).toEqual([])
  })
})
