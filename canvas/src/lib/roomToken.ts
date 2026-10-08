// Ignura rooms are served under ignura.com, so the Supabase session the Ignura site stores in localStorage
// (sb-<ref>-auth-token) is readable here. The canvas sends it so the server can tell a team member from a visitor.
// Read fresh on every call: the parent page refreshes the token while it is open.

export function roomToken(): string {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i) ?? "";
      if (!/^sb-[a-z0-9]+-auth-token$/.test(k)) continue;
      const v = JSON.parse(localStorage.getItem(k) ?? "null");
      const t = v?.access_token ?? v?.currentSession?.access_token;
      if (typeof t === "string" && t) return t;
    }
  } catch {
    /* storage blocked */
  }
  return "";
}

export const authHeaders = (): Record<string, string> => {
  const t = roomToken();
  return t ? { authorization: `Bearer ${t}` } : {};
};

/** EventSource cannot set headers, so a signed-in session rides on the query string (https only, never logged client side). */
export const withToken = (url: string): string => {
  const t = roomToken();
  return t ? `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(t)}` : url;
};
