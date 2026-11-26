// Disclosure behaviour shared by the gallery, toolchain panel and mobile tools
// menu: toggled by its trigger, closed by Escape or a pointer outside.

export interface Popover {
  open(): void;
  close(): void;
  toggle(): void;
}

export function bindPopover(popover: HTMLElement, trigger: HTMLElement, onOpen?: () => void): Popover {
  function onKey(event: KeyboardEvent) {
    if (event.key !== "Escape") return;
    // Closing the popover is all this Escape does; it must not also stop a run.
    event.preventDefault();
    close();
    trigger.focus();
  }

  function onPointer(event: PointerEvent) {
    const target = event.target;
    if (target instanceof Node && !popover.contains(target) && !trigger.contains(target)) close();
  }

  function open() {
    popover.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey, true);
    onOpen?.();
  }

  function close() {
    popover.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", onPointer);
    document.removeEventListener("keydown", onKey, true);
  }

  trigger.addEventListener("click", () => (popover.hidden ? open() : close()));
  return { open, close, toggle: () => (popover.hidden ? open() : close()) };
}
