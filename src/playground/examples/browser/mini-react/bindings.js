// Inspectable, user-editable DOM & event bindings for Titan Mini-React.
// Matches CONTRACTS.md §3: Titan owns VNode diffing, hooks, and component trees;
// JavaScript exposes only minimal DOM primitives and event listeners.

const STYLES = `
  :root {
    color-scheme: dark;
    --bg: #0d0f0a;
    --surface: #141710;
    --raised: #1c2017;
    --rule: rgba(226, 216, 152, 0.16);
    --ink: #eae4d3;
    --muted: #9b957f;
    --gold: #e2d898;
    --gold-ink: #0d0f0a;
    --sage: #a9d1be;
    --coral: #eba08b;
  }
  * { box-sizing: border-box; }
  .mr-stage {
    min-height: 100%;
    padding: 20px;
    background: var(--bg);
    color: var(--ink);
    font: 14px/1.5 "IBM Plex Sans", system-ui, -apple-system, sans-serif;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .mr-app { max-width: 560px; width: 100%; margin: 0 auto; }
  .mr-card {
    background: var(--surface);
    border: 1px solid var(--rule);
    border-radius: 10px;
    padding: 18px 20px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .mr-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }
  .mr-kicker {
    font: 600 11px/1 "IBM Plex Mono", ui-monospace, monospace;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: #b9ad6b;
    margin-bottom: 4px;
  }
  .mr-title {
    margin: 0;
    font: 600 20px/1.2 "Source Serif 4", Georgia, serif;
    color: var(--ink);
  }
  .mr-clock {
    display: flex;
    align-items: center;
    gap: 6px;
    background: var(--raised);
    border: 1px solid var(--rule);
    border-radius: 6px;
    padding: 4px 8px;
    font: 500 12px/1.2 "IBM Plex Mono", ui-monospace, monospace;
  }
  .mr-clock-readout { color: var(--sage); min-width: 50px; text-align: right; }
  .mr-composer { display: flex; gap: 8px; }
  .mr-input {
    flex: 1;
    background: var(--bg);
    color: var(--ink);
    border: 1px solid var(--rule);
    border-radius: 6px;
    padding: 8px 10px;
    font: inherit;
  }
  .mr-input:focus { outline: 2px solid var(--gold); outline-offset: 1px; }
  .mr-btn {
    background: var(--raised);
    color: var(--ink);
    border: 1px solid var(--rule);
    border-radius: 6px;
    padding: 6px 12px;
    font: 500 13px/1.2 inherit;
    cursor: pointer;
  }
  .mr-btn:hover:not(:disabled) { border-color: var(--gold); }
  .mr-btn:focus-visible, .mr-pill:focus-visible {
    outline: 2px solid var(--gold);
    outline-offset: 2px;
  }
  .mr-btn:disabled { opacity: 0.45; cursor: not-allowed; }
  .mr-btn-primary {
    background: var(--gold);
    color: var(--gold-ink);
    border-color: var(--gold);
    font-weight: 600;
  }
  .mr-btn-ghost {
    background: transparent;
    border-color: transparent;
    color: var(--muted);
    padding: 4px 8px;
  }
  .mr-btn-ghost:hover { color: var(--coral); }
  .mr-btn-sm { padding: 3px 8px; font-size: 12px; }
  .mr-filters {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex-wrap: wrap;
  }
  .mr-filter-group { display: flex; gap: 6px; }
  .mr-pill {
    background: transparent;
    color: var(--muted);
    border: 1px solid var(--rule);
    border-radius: 999px;
    padding: 3px 10px;
    font: 500 12px/1.3 inherit;
    cursor: pointer;
  }
  .mr-pill-active {
    background: rgba(226, 216, 152, 0.14);
    color: var(--gold);
    border-color: var(--gold);
  }
  .mr-summary {
    font: 12px/1.3 "IBM Plex Mono", ui-monospace, monospace;
    color: var(--muted);
  }
  .mr-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .mr-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    background: var(--raised);
    border: 1px solid var(--rule);
    border-radius: 6px;
    padding: 8px 10px;
  }
  .mr-item-label {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 1;
    cursor: pointer;
  }
  .mr-item-label input[type="checkbox"] {
    accent-color: var(--gold);
    width: 15px;
    height: 15px;
    cursor: pointer;
  }
  .mr-item-done {
    color: var(--muted);
    text-decoration: line-through;
  }
  .mr-empty {
    margin: 0;
    padding: 14px;
    text-align: center;
    color: var(--muted);
    border: 1px dashed var(--rule);
    border-radius: 6px;
  }
  .mr-status {
    max-width: 560px;
    width: 100%;
    margin: 0 auto;
    font: 12px/1.4 "IBM Plex Mono", ui-monospace, monospace;
    color: var(--muted);
    text-align: center;
  }
`;

function extractPayload(type, event) {
  if (type === "input") return String(event.target?.value ?? "");
  if (type === "change") {
    const target = event.target;
    if (target?.type === "checkbox") return target.checked ? "true" : "false";
    return String(target?.value ?? "");
  }
  if (type === "keydown") return String(event.key ?? "");
  return "";
}

export default function createBindings(host) {
  const style = document.createElement("style");
  style.textContent = STYLES;

  const stage = document.createElement("div");
  stage.className = "mr-stage";

  const appRoot = document.createElement("div");
  appRoot.className = "mr-app";

  const statusLine = document.createElement("div");
  statusLine.className = "mr-status";
  statusLine.setAttribute("role", "status");
  statusLine.setAttribute("aria-live", "polite");

  stage.append(appRoot, statusLine);
  host.root.replaceChildren(style, stage);

  const activeCleanups = new Set();
  host.signal.addEventListener("abort", () => {
    for (const cleanup of activeCleanups) cleanup();
    activeCleanups.clear();
    host.root.replaceChildren();
  }, { once: true });

  return {
    dom_root() {
      return appRoot;
    },

    dom_element(tag) {
      return document.createElement(tag);
    },

    dom_text(content) {
      return document.createTextNode(content);
    },

    dom_set_text(node, content) {
      node.nodeValue = content;
    },

    dom_attr(node, name, value) {
      if (name === "class") node.className = value;
      else if (name === "value") {
        if (node.value !== value) node.value = value;
      } else if (name === "checked") node.checked = value === "true";
      else if (name === "disabled") node.disabled = value === "true";
      else node.setAttribute(name, value);
    },

    dom_remove_attr(node, name) {
      if (name === "class") node.className = "";
      else if (name === "value") node.value = "";
      else if (name === "checked") node.checked = false;
      else if (name === "disabled") node.disabled = false;
      else node.removeAttribute(name);
    },

    dom_insert(parent, node, before) {
      parent.insertBefore(node, before ?? null);
    },

    dom_remove(parent, node) {
      if (node.parentNode === parent) parent.removeChild(node);
    },

    dom_event(node, type) {
      return {
        kind: "listener",
        subscribe(emit) {
          let active = true;
          const fn = (event) => {
            if (!active) return;
            if (type === "submit") event.preventDefault();
            emit(extractPayload(type, event));
          };
          const unregister = () => {
            if (!active) return;
            active = false;
            node.removeEventListener(type, fn);
            activeCleanups.delete(unregister);
          };
          node.addEventListener(type, fn);
          activeCleanups.add(unregister);
          return unregister;
        },
      };
    },

    dom_set_status(text) {
      statusLine.textContent = text;
    },
  };
}
