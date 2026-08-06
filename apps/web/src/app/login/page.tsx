import type { CSSProperties } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { getServices } from "@/server/services";

export const runtime = "nodejs";

export default async function LoginPage({
  searchParams,
}: {
  searchParams?: Promise<{ error?: string }>;
}) {
  const params = searchParams ? await searchParams : {};
  const services = getServices();
  const jar = await cookies();
  const csrf = jar.get(services.policy.csrfCookieName)?.value;
  if (!csrf) {
    redirect("/api/auth/csrf?next=/login");
  }

  return (
    <main style={page}>
      <h1 style={brand}>ReviewPulse</h1>
      <p style={muted}>Sign in with your ReviewPulse account.</p>
      {params.error ? <p style={errorText}>Sign-in failed.</p> : null}
      <form method="post" action="/api/auth/login" style={form}>
        <input type="hidden" name="csrf" value={csrf} />
        <label style={label}>
          Email
          <input
            name="email"
            type="email"
            required
            autoComplete="username"
            style={input}
          />
        </label>
        <label style={label}>
          Password
          <input
            name="password"
            type="password"
            required
            autoComplete="current-password"
            style={input}
          />
        </label>
        <button type="submit" style={button}>
          Sign in
        </button>
      </form>
      <p style={muted}>Accounts are invite-only. There is no public signup.</p>
    </main>
  );
}

const page: CSSProperties = {
  maxWidth: 420,
  margin: "0 auto",
  padding: "4rem 1rem",
  fontFamily: "Georgia, 'Times New Roman', serif",
  color: "#1a1a1a",
};
const brand: CSSProperties = { fontSize: "2.4rem", marginBottom: "0.25rem" };
const muted: CSSProperties = { color: "#4a5560", marginBottom: "1.5rem" };
const errorText: CSSProperties = { color: "#8b1e1e" };
const form: CSSProperties = { display: "grid", gap: "0.75rem" };
const label: CSSProperties = {
  display: "grid",
  gap: "0.35rem",
  fontSize: "0.95rem",
};
const input: CSSProperties = {
  padding: "0.6rem 0.7rem",
  border: "1px solid #8a939c",
  borderRadius: 4,
  fontSize: "1rem",
};
const button: CSSProperties = {
  marginTop: "0.5rem",
  padding: "0.7rem 1rem",
  background: "#1f4b3f",
  color: "#f7f3ea",
  border: "none",
  borderRadius: 4,
  fontSize: "1rem",
  cursor: "pointer",
};
