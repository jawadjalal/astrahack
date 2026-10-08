/** Board ids of Ignura rooms: `rm-` + 24 hex (see canvas_board_visibility in the Ignura database). */
export const isRoomId = (v: unknown): v is string => typeof v === "string" && /^rm-[0-9a-f]{24}$/.test(v);
