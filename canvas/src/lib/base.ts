// Raw fetch/EventSource/<video src> do NOT get Next's basePath. Wrap every app-relative URL:
//   fetch(withBase("/api/state")), new EventSource(withBase("/api/events")), withBase("/uploads/x.mp4")
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || "";
export const withBase = (p: string) => (p.startsWith("/") && !p.startsWith(BASE_PATH + "/") ? BASE_PATH + p : p);
