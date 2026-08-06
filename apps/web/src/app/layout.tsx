import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "ReviewPulse",
  description: "GitLab KPI visibility — read-only M1",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body style={{ margin: 0, minHeight: "100vh" }}>{children}</body>
    </html>
  );
}
