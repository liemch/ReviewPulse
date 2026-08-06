import type { CSSProperties, ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";

import { requireUser } from "@/server/http";

export async function SettingsShell({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  let user;
  try {
    ({ user } = await requireUser());
  } catch {
    redirect("/login");
  }

  return (
    <main style={page}>
      <header style={header}>
        <div>
          <p style={eyebrow}>ReviewPulse</p>
          <h1 style={heading}>{title}</h1>
          <p style={muted}>
            Signed in as {user.email} ({user.role})
          </p>
        </div>
        <nav style={nav}>
          <Link href="/settings/security">Security</Link>
          <Link href="/settings/gitlab">GitLab</Link>
          <Link href="/settings/projects">Projects</Link>
          {user.role === "admin" ? (
            <>
              <Link href="/settings/admin/users">Users</Link>
              <Link href="/settings/admin/allowlist">Allowlist</Link>
            </>
          ) : null}
        </nav>
      </header>
      {children}
    </main>
  );
}

const page: CSSProperties = {
  maxWidth: 880,
  margin: "0 auto",
  padding: "2rem 1rem 4rem",
  fontFamily: "Georgia, 'Times New Roman', serif",
  color: "#1b1f22",
};
const header: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: "1rem",
  flexWrap: "wrap",
  marginBottom: "2rem",
  borderBottom: "1px solid #c5ccd2",
  paddingBottom: "1rem",
};
const eyebrow: CSSProperties = {
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  fontSize: "0.75rem",
  color: "#5b6670",
  margin: 0,
};
const heading: CSSProperties = { margin: "0.2rem 0" };
const muted: CSSProperties = { color: "#5b6670", margin: 0 };
const nav: CSSProperties = {
  display: "flex",
  gap: "0.85rem",
  flexWrap: "wrap",
  alignItems: "center",
};
