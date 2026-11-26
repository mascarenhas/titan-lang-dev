// First-visit card: what is downloading, how much is left, and (after a second
// of samples) how long it should take at the measured rate.
import { copy } from "../content/copy";
import { el } from "./dom";
import { formatBytes, formatMiB } from "./format";

/** One eager toolchain asset; `total` comes from the manifest, `loaded` from progress events. */
export interface AssetProgress {
  tier: 1 | 2;
  path: string;
  loaded: number;
  total: number;
  cached: boolean;
  /** `performance.now()` of the first progress event, or null while queued. */
  started: number | null;
}

function checkIcon(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 12 12");
  svg.setAttribute("width", "11");
  svg.setAttribute("height", "11");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M2.5 6.4l2.3 2.3 4.7-5");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.8");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  return svg;
}

function row(asset: AssetProgress): HTMLElement {
  const done = asset.total > 0 && asset.loaded >= asset.total;
  const state = done ? "is-done" : asset.started === null ? "is-queued" : "is-going";
  const percent = asset.total === 0 ? 0 : Math.floor((100 * asset.loaded) / asset.total);
  return el(
    "li",
    { class: `pg-asset ${state}` },
    el("span", { class: "pg-asset-state", "aria-hidden": "true" }, done ? checkIcon() : asset.started === null ? "·" : "↓"),
    el("span", { class: "pg-asset-name" }, el("code", {}, asset.path)),
    el(
      "span",
      { class: "pg-asset-size" },
      done || asset.started === null
        ? formatBytes(asset.total)
        : copy.pipeline.tierProgress(formatMiB(asset.loaded), formatMiB(asset.total)),
    ),
    el("span", { class: "pg-asset-bar" }, el("i", { style: `width:${percent}%` })),
  );
}

const sum = (list: readonly AssetProgress[], key: "loaded" | "total") => list.reduce((total, asset) => total + asset[key], 0);

/** Percent of a tier's known bytes, or null before its size is known. */
export function tierPercent(rows: readonly AssetProgress[], tier: 1 | 2): number | null {
  const list = rows.filter((asset) => asset.tier === tier);
  const total = sum(list, "total");
  return total === 0 ? null : Math.floor((100 * sum(list, "loaded")) / total);
}

export function renderWarming(
  target: HTMLElement,
  rows: readonly AssetProgress[],
  status: { checkingLive: boolean; sessionOnly: boolean },
): void {
  const tier1 = rows.filter((asset) => asset.tier === 1);
  const tier2 = rows.filter((asset) => asset.tier === 2);
  // Rate over network transfers only; cached assets arrive instantly and say nothing about the link.
  const fetched = tier2.filter((asset) => !asset.cached && asset.started !== null);
  const firstStart = Math.min(...fetched.map((asset) => asset.started ?? Infinity));
  const elapsed = (performance.now() - firstStart) / 1000;
  const rate = elapsed >= 1 ? sum(fetched, "loaded") / elapsed : 0;
  const left = sum(tier2, "total") - sum(tier2, "loaded");
  const tier = (label: string, list: AssetProgress[]) => [
    el(
      "div",
      { class: "pg-tier" },
      el("span", {}, label),
      el("span", { class: "pg-tier-size" }, copy.pipeline.tierProgress(formatMiB(sum(list, "loaded")), formatMiB(sum(list, "total")))),
    ),
    el("ul", { class: "pg-assets" }, ...list.map(row)),
  ];

  target.replaceChildren(
    el(
      "div",
      { class: "pg-warmcard" },
      el("span", { class: "pg-kicker" }, copy.pipeline.warmingKicker),
      el("h2", {}, copy.pipeline.warmingTitle),
      el("p", {}, copy.pipeline.warmingBody),
      ...tier(copy.pipeline.tier1, tier1),
      ...tier(copy.pipeline.tier2, tier2),
      status.checkingLive
        ? el("div", { class: "pg-callout" }, el("span", { class: "pg-lamp", "aria-hidden": "true" }), copy.pipeline.checkingLive)
        : null,
      status.sessionOnly ? el("p", { class: "pg-session-note" }, copy.pipeline.sessionOnly) : null,
      rate > 0 && left > 0
        ? el("div", { class: "pg-warm-foot" }, copy.pipeline.eta(formatMiB(left), Math.ceil(left / rate), formatMiB(rate)))
        : null,
    ),
  );
}
