import type { HealthResponse } from "@rag/shared-types";

async function getApiHealth(): Promise<HealthResponse | null> {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

  try {
    const res = await fetch(`${apiUrl}/health`, { cache: "no-store" });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export default async function HomePage() {
  const health = await getApiHealth();

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center gap-6 p-8">
      <div className="text-center">
        <h1 className="text-4xl font-bold tracking-tight">RAG Platform</h1>
        <p className="mt-2 text-gray-600">
          Drive-style knowledge base with dynamic scoped RAG
        </p>
      </div>

      <div className="w-full rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
        <h2 className="text-sm font-medium uppercase tracking-wide text-gray-500">
          API Status
        </h2>
        {health ? (
          <p className="mt-2 text-lg">
            <span className="inline-block h-2 w-2 rounded-full bg-green-500 mr-2" />
            {health.service} — {health.status}
          </p>
        ) : (
          <p className="mt-2 text-lg text-amber-600">
            API unreachable (start apps/api)
          </p>
        )}
      </div>
    </main>
  );
}
