/**
 * Scenario setup shared by the idle and streaming profilers.
 *
 * Idle and streaming cost both depend on how much of the sidebar is mounted,
 * so both commands need the same way to reach a heavily populated sidebar.
 * Setup always runs before the measured window.
 */

import { evaluateValue, wait } from "./cdp.mjs"

/**
 * Expands every node of the sidebar workspace tree by clicking each collapsed
 * chevron until none remain. The tree persists its expansion
 * (oc.sidebar.tree.expanded.v1), so a following reload keeps it. Waits up to
 * `readyMs` for the tree to render first.
 */
export const expandProjects = async (client, { readyMs = 15_000, passes = 20, settleMs = 300 } = {}) => {
  const deadline = Date.now() + readyMs
  while (Date.now() < deadline) {
    const ready = await evaluateValue(client, `document.querySelectorAll("[role=tree] [data-tree-node]").length`)
    if (ready) break
    await wait(250)
  }
  let totalClicked = 0
  for (let pass = 0; pass < passes; pass += 1) {
    const clicked = await evaluateValue(client, `(() => {
      const toggles = [...document.querySelectorAll('[data-tree-node][aria-expanded="false"] [data-tree-toggle]')]
      for (const toggle of toggles) toggle.click()
      return toggles.length
    })()`)
    if (!clicked) break
    totalClicked += clicked
    await wait(settleMs)
  }
  return totalClicked
}

/**
 * Clicks every "Show more sessions" control until none remain.
 *
 * Session list pagination is component state, so unlike project collapse it
 * cannot be seeded through storage. The controls only exist once the sidebar
 * has populated, so call this after the page has settled, never straight after
 * the load event.
 *
 * Matching is a case-insensitive substring test, which assumes the English UI
 * locale; a non-English locale expands nothing and reports zero.
 */
export const expandSessionLists = async (client, { passes = 40, settleMs = 400 } = {}) => {
  let totalClicked = 0
  for (let pass = 0; pass < passes; pass += 1) {
    const clicked = await evaluateValue(client, `(() => {
      const controls = [...document.querySelectorAll("button")]
        .filter((button) => (button.textContent ?? "").toLowerCase().includes("show more"))
      for (const control of controls) control.click()
      return controls.length
    })()`)
    if (!clicked) break
    totalClicked += clicked
    await wait(settleMs)
  }
  return totalClicked
}
