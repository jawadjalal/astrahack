"use client";

/** An Ignura room with nothing on it yet. Pointer events pass through. */
export function RoomEmpty({ readOnly }: { readOnly: boolean }) {
  return (
    <div className="ig-empty">
      <h1>{readOnly ? "Nothing on this board yet." : "Getting your board ready…"}</h1>
      {!readOnly && (
        <p className="ig-empty-hint">
          Drop an image, screenshot or MP4 anywhere, or hit <b>Add</b>.
        </p>
      )}
    </div>
  );
}
