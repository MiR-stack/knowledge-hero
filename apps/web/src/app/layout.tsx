import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "RAG Platform",
  description: "Drive-style knowledge base with scoped RAG",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-gray-50 text-gray-900 antialiased">
        {children}
      </body>
    </html>
  );
}
