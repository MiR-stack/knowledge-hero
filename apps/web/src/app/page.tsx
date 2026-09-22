import Link from "next/link";

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center gap-6 p-8">
      <div className="text-center">
        <h1 className="text-4xl font-bold tracking-tight">RAG Platform</h1>
        <p className="mt-2 text-gray-600">
          Drive-style knowledge base with dynamic scoped RAG
        </p>
      </div>

      <div className="flex gap-4">
        <Link
          href="/drive"
          className="rounded-md bg-blue-600 px-6 py-3 text-sm font-medium text-white hover:bg-blue-700"
        >
          Open Drive
        </Link>
        <Link
          href="/login"
          className="rounded-md border border-gray-300 px-6 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          Sign in
        </Link>
      </div>
    </main>
  );
}
