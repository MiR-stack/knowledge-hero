import type { Metadata } from "next";
import "./globals.css";
import { AuthProvider } from "../lib/auth";

export const metadata: Metadata = {
  title: "Drive",
  description: "Drive-style knowledge base with scoped RAG",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-white text-drive-text antialiased">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
