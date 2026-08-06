import Link from "next/link";

export default function HomePage() {
  return (
    <main
      style={{
        minHeight: "100vh",
        padding: "4rem 1.25rem",
        fontFamily: "Georgia, 'Times New Roman', serif",
        color: "#1b1f22",
        background:
          "linear-gradient(160deg, #f4efe4 0%, #e4eef1 45%, #d7e5de 100%)",
      }}
    >
      <div style={{ maxWidth: 640, margin: "0 auto" }}>
        <h1 style={{ fontSize: "3rem", marginBottom: "0.4rem" }}>ReviewPulse</h1>
        <p style={{ fontSize: "1.15rem", color: "#44525c" }}>
          GitLab KPI visibility for engineering teams — invite-only access.
        </p>
        <p style={{ marginTop: "2rem" }}>
          <Link href="/login" style={{ color: "#1f4b3f", fontWeight: 600 }}>
            Sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
