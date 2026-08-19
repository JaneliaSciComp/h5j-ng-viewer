// The Neuroglancer viewport once rendered as a one-pixel sliver because index.css
// styled `.side-panel`/`.viewer-area` while App.tsx rendered `.panel`/`.viewer`. The
// rule that gave the viewer its height simply never matched: no error, no failing
// test, and a layout that looks deliberate. This guards against that whole class of
// silent mismatch.

import { readFileSync, readdirSync } from "node:fs"
import { describe, expect, it } from "vitest"

const CSS = readFileSync("src/index.css", "utf8")

/** Class names our own components apply, from static className string literals. */
function usedClassNames(): Map<string, string> {
  const files = [
    "src/App.tsx",
    ...readdirSync("src/components").map((name) => `src/components/${name}`),
  ].filter((path) => path.endsWith(".tsx"))

  const found = new Map<string, string>()
  for (const path of files) {
    const source = readFileSync(path, "utf8")
    for (const match of source.matchAll(/className="([^"{}]+)"/g)) {
      for (const name of match[1].split(/\s+/).filter(Boolean)) {
        if (!found.has(name)) found.set(name, path)
      }
    }
  }
  return found
}

/** Class names index.css defines a rule for, plus what Neuroglancer's own sheet owns. */
function definedClassNames(): Set<string> {
  const defined = new Set<string>()
  // Strip comments so a class name merely mentioned in prose does not count.
  const withoutComments = CSS.replace(/\/\*[\s\S]*?\*\//g, "")
  for (const match of withoutComments.matchAll(/\.([A-Za-z][\w-]*)/g)) {
    defined.add(match[1])
  }
  return defined
}

describe("component class names have matching CSS", () => {
  it("defines a rule for every className our components apply", () => {
    const defined = definedClassNames()
    // `ng` is handed to NeuroglancerViewer, which styles its own container.
    const externallyStyled = new Set(["ng"])

    const orphans = [...usedClassNames()]
      .filter(([name]) => !defined.has(name) && !externallyStyled.has(name))
      .map(([name, path]) => `${name} (${path})`)

    expect(orphans).toEqual([])
  })

  it("keeps the flex chain that gives the viewer a definite height", () => {
    // Neuroglancer's container is height:100%, so it needs a resolved height from its
    // ancestors. `min-height: 0` is the non-obvious half: without it the flex item
    // will not shrink below its content and the viewer collapses.
    expect(CSS).toMatch(/html,\s*body,\s*#root\s*\{[^}]*height:\s*100%/)
    expect(CSS).toMatch(/\.viewer-area\s*\{[^}]*flex:\s*1 1 auto[^}]*\}/s)
    expect(CSS).toMatch(/\.viewer-area\s*\{[^}]*min-height:\s*0[^}]*\}/s)
  })
})
