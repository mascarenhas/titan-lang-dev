// The toolchain panel behind the pipeline lamps: what each tier holds in this
// browser, Clear cache, and the optional program input passed as stdin.
import { copy } from "../content/copy";
import { el, part } from "./dom";
import { bindPopover, type Popover } from "./popover";

export type TierView = { state: "ready" | "loading" | "pending" | "failed"; percent: number | null };

export interface PanelView {
  tier1: TierView;
  tier2: TierView;
  sessionOnly: boolean;
}

export interface PanelHooks {
  clearCache(): void;
  /** The text to connect as stdin, or undefined when the program input is disconnected. */
  stdin(value: string | undefined): void;
}

export interface PanelController extends Popover {
  render(view: PanelView): void;
}

function tierStatus(tier: TierView): string {
  if (tier.state === "ready") return copy.pipeline.tierReady;
  if (tier.state === "pending") return copy.pipeline.tierPending;
  if (tier.state === "loading") return tier.percent === null ? "…" : `${tier.percent}%`;
  return copy.output.chipFailed;
}

export function createToolchainPanel(popover: HTMLElement, trigger: HTMLElement, hooks: PanelHooks): PanelController {
  const tiers = part(popover, "panel-tiers");
  const session = part(popover, "panel-session");
  const connect = part<HTMLInputElement>(popover, "stdin-connect");
  const input = part<HTMLTextAreaElement>(popover, "stdin-text");
  const disclosure = bindPopover(popover, trigger);

  part(popover, "clear-cache").addEventListener("click", () => hooks.clearCache());
  const report = () => {
    input.disabled = !connect.checked;
    hooks.stdin(connect.checked ? input.value : undefined);
  };
  connect.addEventListener("change", report);
  input.addEventListener("input", report);

  return {
    ...disclosure,
    render(view) {
      tiers.replaceChildren(
        ...(
          [
            [copy.pipeline.tier1, view.tier1],
            [copy.pipeline.tier2, view.tier2],
          ] as const
        ).map(([label, tier]) =>
          el(
            "li",
            { "data-state": tier.state },
            el("span", { class: "pg-lamp", "aria-hidden": "true" }),
            el("span", {}, label),
            el("span", { class: "pg-panel-status" }, tierStatus(tier)),
          ),
        ),
      );
      session.hidden = !view.sessionOnly;
    },
  };
}
