import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Shotlin — garment image studio",
  description: "Zero-prompt garment image generation with fidelity-first review.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
