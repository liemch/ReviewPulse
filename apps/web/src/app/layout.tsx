import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "ReviewPulse",
  description: "Theo dõi KPI GitLab cho đội phát triển — chỉ đọc (M1)",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="vi">
      <body>{children}</body>
    </html>
  );
}
