import RunExperience from "../components/RunExperience";

export default async function Home({ searchParams }: { searchParams: Promise<{ run?: string; view?: string; demo?: string }> }) {
  const params = await searchParams;
  return <RunExperience initialRunId={params.run || null} initialCanvas={params.view === "canvas"} recordedIgnura={params.demo === "ignura" && !params.run} />;
}
