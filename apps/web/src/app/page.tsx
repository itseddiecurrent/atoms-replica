import { HomePrompt } from "./home-prompt";

export default async function HomePage({
  searchParams
}: {
  searchParams?: Promise<{ prompt?: string }>;
}) {
  const params = await searchParams;

  return (
    <main className="grid min-h-screen place-items-center px-6">
      <section className="w-full max-w-3xl rounded-3xl border border-zinc-200 bg-white p-10 shadow-sm">
        <p className="mb-3 text-sm font-medium text-violet-600">Atom Replica · AI App Builder</p>
        <h1 className="text-4xl font-semibold tracking-tight">Tell AI about your app idea</h1>
        <p className="mt-4 max-w-2xl text-zinc-600">
          Generate a working app, watch the Agent build it in real time, then refine the code and
          Preview from one workspace.
        </p>
        <HomePrompt initialPrompt={params?.prompt} />
      </section>
    </main>
  );
}
