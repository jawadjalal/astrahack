export type Severity = "critical" | "high" | "medium" | "low" | "info";

export const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;

// Ignura-warm severities: tomato / orange / butter / sky / warm grey. Used for strokes and chips on paper.
export const SEVERITY_COLOR: Record<Severity, string> = {
  critical: "#E63E27",
  high: "#FF6A1F",
  medium: "#E8A400",
  low: "#3F86CC",
  info: "#8B8277",
};

// Readable text color for each severity on paper/tint (the stroke colors above fail AA for small text).
export const SEVERITY_INK: Record<Severity, string> = {
  critical: "#B42411",
  high: "#B33805",
  medium: "#8A5F00",
  low: "#23609F",
  info: "#665E55",
};

export const SEVERITY_TINT: Record<Severity, string> = {
  critical: "#FDE3DD",
  high: "#FFE3CF",
  medium: "#FFF1C2",
  low: "#DCEBFA",
  info: "#EFE8DC",
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

export function sevInk(s: string | undefined): string {
  return SEVERITY_INK[(s as Severity) ?? "medium"] ?? SEVERITY_INK.medium;
}

export function sevTint(s: string | undefined): string {
  return SEVERITY_TINT[(s as Severity) ?? "medium"] ?? SEVERITY_TINT.medium;
}
