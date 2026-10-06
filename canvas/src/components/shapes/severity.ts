export type Severity = "critical" | "high" | "medium" | "low" | "info";

export const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;

export const SEVERITY_COLOR: Record<Severity, string> = {
  critical: "#dc2626",
  high: "#ea580c",
  medium: "#d97706",
  low: "#2563eb",
  info: "#6b7280",
};

export const SEVERITY_TINT: Record<Severity, string> = {
  critical: "#fef2f2",
  high: "#fff7ed",
  medium: "#fffbeb",
  low: "#eff6ff",
  info: "#f3f4f6",
};

// Nearest tldraw default color name, for native shapes (arrows) drawn for a severity.
export const SEVERITY_TLDRAW_COLOR: Record<Severity, "red" | "orange" | "yellow" | "blue" | "grey"> = {
  critical: "red",
  high: "orange",
  medium: "yellow",
  low: "blue",
  info: "grey",
};

export function sevColor(s: string | undefined): string {
  return SEVERITY_COLOR[(s as Severity) ?? "medium"] ?? SEVERITY_COLOR.medium;
}

export function sevTint(s: string | undefined): string {
  return SEVERITY_TINT[(s as Severity) ?? "medium"] ?? SEVERITY_TINT.medium;
}
