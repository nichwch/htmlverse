import type { Metadata } from "next";
import { Geist_Mono } from "next/font/google";
import { Agentation } from "agentation";
import FolderReconnect from "@/components/FolderReconnect";
import "./globals.css";

const mono = Geist_Mono({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "proto",
  description: "prototype interfaces on a canvas",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={mono.className}>
      <body>
        {children}
        <FolderReconnect />
        {process.env.NODE_ENV === "development" && <Agentation />}
      </body>
    </html>
  );
}
