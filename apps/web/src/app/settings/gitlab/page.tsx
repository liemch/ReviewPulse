import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { SettingsShell } from "../_components/shell";
import { requireUser } from "@/server/http";
import { getServices } from "@/server/services";

export const runtime = "nodejs";

export default async function GitLabSettingsPage() {
  const services = getServices();
  const jar = await cookies();
  const csrf = jar.get(services.policy.csrfCookieName)?.value;
  if (!csrf) {
    redirect("/api/auth/csrf?next=/settings/gitlab");
  }

  const { user } = await requireUser();
  const connections = await services.connections.listForUser(user.id);

  return (
    <SettingsShell title="GitLab connection">
      <section style={{ marginBottom: "2rem" }}>
        <h2>Current connections</h2>
        {connections.length === 0 ? (
          <p>No GitLab connection yet.</p>
        ) : (
          <ul>
            {connections.map((connection) => (
              <li key={connection.id} style={{ marginBottom: "1rem" }}>
                <strong>{connection.baseUrlNormalized}</strong>
                <div>
                  @{connection.gitlabUsername} · status {connection.status}
                  {connection.patHintLast4
                    ? ` · PAT …${connection.patHintLast4}`
                    : ""}
                </div>
                <form
                  method="post"
                  action="/api/settings/gitlab"
                  style={{ display: "inline-flex", gap: "0.5rem", marginTop: "0.4rem" }}
                >
                  <input type="hidden" name="csrf" value={csrf} />
                  <input type="hidden" name="connectionId" value={connection.id} />
                  <button type="submit" name="action" value="retest">
                    Test
                  </button>
                  <button type="submit" name="action" value="delete">
                    Delete
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Add or replace PAT</h2>
        <p>
          Enter an exact allowlisted GitLab URL and your personal{" "}
          <code>read_api</code> PAT. The token is never shown again.
        </p>
        <form method="post" action="/api/settings/gitlab" style={{ display: "grid", gap: "0.6rem", maxWidth: 480 }}>
          <input type="hidden" name="csrf" value={csrf} />
          <input type="hidden" name="action" value="save" />
          <label>
            GitLab base URL
            <input name="baseUrl" required placeholder="https://gitlab.example.com" style={{ width: "100%" }} />
          </label>
          <label>
            Personal access token
            <input name="pat" type="password" required autoComplete="off" style={{ width: "100%" }} />
          </label>
          <button type="submit">Save connection</button>
        </form>
      </section>
    </SettingsShell>
  );
}
