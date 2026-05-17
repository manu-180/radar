import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  // `template` aplica a las páginas hijas: una página con `title: "Leads"`
  // termina mostrando "Leads · Lead Detector" en la pestaña del navegador.
  title: {
    default: "Lead Detector",
    template: "%s · Lead Detector",
  },
  description:
    "Panel del detector de leads: monitorea plataformas online, clasifica los " +
    "candidatos con IA y avisa los mejores prospectos por WhatsApp.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="es"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
