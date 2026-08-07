import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { AppShell } from "@/components/layout/app-shell";
import { IconFolder, IconGitBranch } from "@/components/icons";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHead } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { DataTable } from "@/components/ui/table";
import { PageHeader } from "@/components/ui/page-header";
import { formErrorMessage } from "@/lib/labels";
import { requireUser } from "@/server/http";
import { getServices } from "@/server/services";

export const runtime = "nodejs";

const COLUMNS = ["Dự án", "Hiển thị với PAT", "Trạng thái", "Hành động"];

export default async function ProjectsSettingsPage({
  searchParams,
}: {
  searchParams?: Promise<{ error?: string }>;
}) {
  const services = getServices();
  const jar = await cookies();
  const csrf = jar.get(services.policy.csrfCookieName)?.value;
  if (!csrf) {
    redirect("/api/auth/csrf?next=/settings/projects");
  }

  const params = searchParams ? await searchParams : {};
  const errorMessage = formErrorMessage(params.error);
  const { user } = await requireUser();
  const connections = await services.connections.listForUser(user.id);
  const projects = await services.projects.listForUser(user.id);

  return (
    <AppShell active="projects" csrf={csrf}>
      <PageHeader
        title="Dự án"
        description="Bật dự án để ReviewPulse theo dõi. Bật dự án không cấp quyền truy cập cho bất kỳ ai khác."
        icon={<IconFolder size={22} />}
      />

      {errorMessage ? <Alert tone="danger">{errorMessage}</Alert> : null}

      <Card>
        <CardHead
          title="Dự án khả dụng"
          description="Chỉ dự án nằm trong danh sách cho phép và PAT của bạn nhìn thấy mới có thể bật."
          icon={<IconFolder size={17} />}
        />
        <CardBody>
          {connections.length === 0 ? (
            <EmptyState
              icon={<IconGitBranch size={22} />}
              title="Bạn cần kết nối GitLab trước"
              description="ReviewPulse dùng PAT của bạn để xác định các dự án bạn có quyền xem."
              action={
                <ButtonLink href="/settings/gitlab" variant="primary">
                  Kết nối GitLab
                </ButtonLink>
              }
            />
          ) : projects.length === 0 ? (
            <EmptyState
              title="Chưa có dự án nào khả dụng"
              description="Không có dự án nào vừa nằm trong danh sách cho phép, vừa hiển thị với PAT hiện tại. Hãy liên hệ quản trị viên để thêm dự án vào danh sách cho phép."
            />
          ) : (
            <DataTable caption="Danh sách dự án khả dụng" columns={COLUMNS}>
              {projects.map((project) => (
                <tr
                  key={`${project.gitlabInstanceId}:${project.gitlabProjectId}`}
                >
                  <td>
                    <div className="rp-table-primary">
                      {project.pathWithNamespace ?? project.gitlabProjectId}
                    </div>
                    <div className="rp-table-sub">
                      GitLab project id: {project.gitlabProjectId}
                    </div>
                    {project.error ? (
                      <div className="rp-field-error">{project.error}</div>
                    ) : null}
                  </td>
                  <td>
                    <Badge tone={project.gitlabVisible ? "success" : "neutral"}>
                      {project.gitlabVisible ? "Có" : "Không"}
                    </Badge>
                  </td>
                  <td>
                    <Badge tone={project.enabled ? "accent" : "neutral"}>
                      {project.enabled ? "Đang theo dõi" : "Chưa bật"}
                    </Badge>
                  </td>
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
                      <Button
                        type="submit"
                        name="action"
                        value={project.enabled ? "disable" : "enable"}
                        variant={project.enabled ? "secondary" : "primary"}
                        size="sm"
                        disabled={!project.gitlabVisible && !project.enabled}
                      >
                        {project.enabled ? "Tắt theo dõi" : "Bật theo dõi"}
                      </Button>
                    </form>
                  </td>
                </tr>
              ))}
            </DataTable>
          )}
        </CardBody>
      </Card>
    </AppShell>
  );
}
