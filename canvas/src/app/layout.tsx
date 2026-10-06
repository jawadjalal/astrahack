import type { Metadata } from "next";
import "./globals.css";
import { fontFaceCss } from "../lib/ignuraFonts";
import { withBase } from "../lib/base";

export const metadata: Metadata = {
  title: "Astrahack Canvas",
  description: "A hand-drawn whiteboard your agent draws on, live.",
  icons: { icon: withBase("/ignura/iggy/iggy-mark.svg") },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased">
      <head>
        <style dangerouslySetInnerHTML={{ __html: fontFaceCss() }} />
        <link rel="preload" as="font" type="font/woff2" crossOrigin="anonymous" href={withBase("/ignura/fonts/caveat-latin-600-normal-v2.woff2")} />
        <link rel="preload" as="font" type="font/woff2" crossOrigin="anonymous" href={withBase("/ignura/fonts/pixelify-sans-latin-500-normal-v2.woff2")} />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
