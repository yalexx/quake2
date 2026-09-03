import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Quake 2",
  description: "Unofficial WebAssembly port of the id Tech 2 engine",
  icons: {
    icon: "/icon.svg",
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
