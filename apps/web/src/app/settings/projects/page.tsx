import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { SettingsShell } from "../_components/shell";
import { requireUser } from "@/server/http";
import { getServices } from "@/server/services";

export const runtime = "nodejs";

export default async function ProjectsSettingsPage() {
  const services = getServices();
  const jar = await cookies();
  const csrf = jar.get(services.policy.csrfCookieName)?.value;
  if (!csrf) {
    redirect("/api/auth/csrf?next=/settings/projects");
  }

  const { user } = await requireUser();
  const projects = await services.projects.listForUser(user.id);

  return (
    <SettingsShell title="Projects">
      <p>
        Only projects on the ReviewPulse allowlist that your GitLab PAT can see
        may be enabled. Enabling a project does not grant access to anyone else.
      </p>
      {projects.length === 0 ? (
        <p>No allowlisted projects available for your connections.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th align="left">Project</th>
              <th align="left">Visible</th>
              <th align="left">Enabled</th>
              <th align="left">Action</th>
            </tr>
          </thead>
          <tbody>
            {projects.map((project) => (
              <tr key={`${project.gitlabInstanceId}:${project.gitlabProjectId}`}>
                <td>
                  {project.pathWithNamespace ?? project.gitlabProjectId}
                  {project.error ? (
                    <div style={{ color: "#8b1e1e" }}>{project.error}</div>
                  ) : null}
                </td>
                <td>{project.gitlabVisible ? "yes" : "no"}</td>
                <td>{project.enabled ? "yes" : "no"}</td>
                <td>
                  <form method="post" action="/api/settings/projects">
                    <input type="hidden" name="csrf" value={csrf} />
                    <input
                      type="hidden"
                      name="gitlabInstanceId"
                      value={project.gitlabInstanceId}
                    />
                    <input
                      type="hidden"
                      name="gitlabProjectId"
                      value={project.gitlabProjectId}
                    />
                    <button
                      type="submit"
                      name="action"
                      value={project.enabled ? "disable" : "enable"}
                      disabled={!project.gitlabVisible && !project.enabled}
                    >
                      {project.enabled ? "Disable" : "Enable"}
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </SettingsShell>
  );
}
