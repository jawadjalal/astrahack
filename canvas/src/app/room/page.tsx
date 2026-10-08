import type { Metadata } from "next";
import RoomBoard from "../../components/RoomBoard";

// An Ignura project room's whiteboard. Embedded by ignura.com/canvas/<room>; never indexed.
export const metadata: Metadata = {
  title: "Room · Ignura",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function Room({ searchParams }: { searchParams: Promise<{ board?: string; ro?: string; agent?: string }> }) {
  const params = await searchParams;
  // the name on the cursor: Iggy unless ?agent=<name> (a person, a different agent). Plain text, short.
  const agent = (params.agent ?? "").replace(/[^\p{L}\p{N} ._-]/gu, "").trim().slice(0, 24) || undefined;
  return <RoomBoard board={params.board ?? ""} readOnly={params.ro !== "0"} agent={agent} />;
}
