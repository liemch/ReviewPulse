import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { SettingsShell } from "../../_components/shell";
import { requireAdmin } from "@/server/http";
import { getServices } from "@/server/services";

export const runtime = "nodejs";

export default async function AdminAllowlistPage() {
  await requireAdmin();
  const services = getServices();
  const jar = await cookies();
  const csrf = jar.get(services.policy.csrfCookieName)?.value;
  if (!csrf) {
    redirect("/api/auth/csrf?next=/settings/admin/allowlist");
  }

  const instances = await services.allowlist.listInstances();
  const projects = await services.allowlist.listProjects();

  return (
    <SettingsShell title="Allowlists">
      <section style={{ marginBottom: "2rem" }}>
        <h2>GitLab instances</h2>
        <ul>
          {instances.map((instance) => (
            <li key={instance.id}>
              {instance.baseUrlNormalized}
              {instance.internal ? " (internal)" : ""}
              <form method="post" action="/api/admin/allowlist" style={{ display: "inline", marginLeft: 8 }}>
                <input type="hidden" name="csrf" value={csrf} />
                <input type="hidden" name="action" value="remove_instance" />
                <input type="hidden" name="instanceId" value={instance.id} />
                <button type="submit">Remove</button>
              </form>
            </li>
          ))}
        </ul>
        <form method="post" action="/api/admin/allowlist" style={{ display: "grid", gap: 8, maxWidth: 480 }}>
          <input type="hidden" name="csrf" value={csrf} />
          <input type="hidden" name="action" value="add_instance" />
          <input name="baseUrl" required placeholder="https://gitlab.example.com" />
          <input name="label" placeholder="label (optional)" />
          <label>
            <input type="checkbox" name="internal" value="true" /> Allow RFC1918 for this origin
          </label>
          <button type="submit">Add instance</button>
        </form>
      </section>

      <section>
        <h2>Projects</h2>
        <ul>
          {projects.map((project) => (
            <li key={project.id}>
              {project.pathWithNamespace ?? project.gitlabProjectId} ({project.gitlabInstanceId})
              <form method="post" action="/api/admin/allowlist" style={{ display: "inline", marginLeft: 8 }}>
                <input type="hidden" name="csrf" value={csrf} />
                <input type="hidden" name="action" value="remove_project" />
                <input type="hidden" name="id" value={project.id} />
                <button type="submit">Remove</button>
              </form>
            </li>
          ))}
        </ul>
        <form method="post" action="/api/admin/allowlist" style={{ display: "grid", gap: 8, maxWidth: 480 }}>
          <input type="hidden" name="csrf" value={csrf} />
          <input type="hidden" name="action" value="add_project" />
          <select name="gitlabInstanceId" required defaultValue="">
            <option value="" disabled>
              Select instance
            </option>
            {instances.map((instance) => (
              <option key={instance.id} value={instance.id}>
                {instance.baseUrlNormalized}
              </option>
            ))}
          </select>
          <input name="gitlabProjectId" required placeholder="GitLab project id" />
          <input name="pathWithNamespace" placeholder="group/project (optional)" />
          <button type="submit">Add project</button>
        </form>
      </section>
    </SettingsShell>
  );
}
