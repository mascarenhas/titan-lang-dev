// Formatting for measured values (status copy rule: sizes in MiB, one decimal).

const MIB = 1024 * 1024;

export function formatMiB(bytes: number, digits = 1): string {
  return (bytes / MIB).toFixed(digits);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MIB) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${formatMiB(bytes)} MiB`;
}

/** `mm:ss.t` for a running program's clock. */
export function formatClock(ms: number): string {
  const seconds = ms / 1000;
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${(seconds % 60).toFixed(1).padStart(4, "0")}`;
}

const relative = new Intl.RelativeTimeFormat("en", { numeric: "always" });

/** "12 seconds ago", for stale run output. */
export function formatAgo(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return relative.format(-seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return relative.format(-minutes, "minute");
  return relative.format(-Math.round(minutes / 60), "hour");
}
