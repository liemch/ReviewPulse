import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { SettingsShell } from "../../_components/shell";
import { requireAdmin } from "@/server/http";
import { getServices } from "@/server/services";

export const runtime = "nodejs";

export default async function AdminUsersPage() {
  await requireAdmin();
  const services = getServices();
  const jar = await cookies();
  const csrf = jar.get(services.policy.csrfCookieName)?.value;
  if (!csrf) {
    redirect("/api/auth/csrf?next=/settings/admin/users");
  }

  const { user: actor } = await requireAdmin();
  const users = await services.users.listUsers(actor);

  return (
    <SettingsShell title="User management">
      <section style={{ marginBottom: "2rem" }}>
        <h2>Create user</h2>
        <form method="post" action="/api/admin/users" style={{ display: "grid", gap: "0.5rem", maxWidth: 420 }}>
          <input type="hidden" name="csrf" value={csrf} />
          <input type="hidden" name="action" value="create" />
          <input name="email" type="email" required placeholder="email" />
          <input name="password" type="password" required placeholder="temporary password" minLength={12} />
          <select name="role" defaultValue="developer">
            <option value="developer">developer</option>
            <option value="tech_lead">tech_lead</option>
            <option value="admin">admin</option>
          </select>
          <button type="submit">Create</button>
        </form>
      </section>

      <section>
        <h2>Users</h2>
        <ul>
          {users.map((user) => (
            <li key={user.id} style={{ marginBottom: "0.75rem" }}>
              {user.email} · {user.role} · {user.status}
              {user.id !== actor.id && user.status === "active" ? (
                <form method="post" action="/api/admin/users" style={{ display: "inline", marginLeft: "0.5rem" }}>
                  <input type="hidden" name="csrf" value={csrf} />
                  <input type="hidden" name="action" value="deactivate" />
                  <input type="hidden" name="userId" value={user.id} />
                  <button type="submit">Deactivate</button>
                </form>
              ) : null}
              {user.status === "active" ? (
                <form
                  method="post"
                  action="/api/admin/users"
                  style={{ display: "inline-flex", gap: "0.35rem", marginLeft: "0.5rem" }}
                >
                  <input type="hidden" name="csrf" value={csrf} />
                  <input type="hidden" name="action" value="reset_password" />
                  <input type="hidden" name="userId" value={user.id} />
                  <input
                    name="password"
                    type="password"
                    required
                    minLength={12}
                    placeholder="new password"
                  />
                  <button type="submit">Reset password</button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    </SettingsShell>
  );
}
