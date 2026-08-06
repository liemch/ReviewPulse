import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { AppShell } from "@/components/layout/app-shell";
import {
  IconFolder,
  IconGitBranch,
  IconListCheck,
  IconPlus,
} from "@/components/icons";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHead } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Checkbox, Field, Select, TextInput } from "@/components/ui/field";
import { EmptyState } from "@/components/ui/empty-state";
import { DataTable } from "@/components/ui/table";
import { PageHeader } from "@/components/ui/page-header";
import { formErrorMessage } from "@/lib/labels";
import { requireAdmin } from "@/server/http";
import { getServices } from "@/server/services";

export const runtime = "nodejs";

const INSTANCE_COLUMNS = ["GitLab URL", "Nhãn", "Phạm vi mạng", "Hành động"];
const PROJECT_COLUMNS = ["Dự án", "GitLab instance", "Hành động"];

export default async function AdminAllowlistPage({
  searchParams,
}: {
  searchParams?: Promise<{ error?: string }>;
}) {
  const services = getServices();
  const jar = await cookies();
  const csrf = jar.get(services.policy.csrfCookieName)?.value;
  if (!csrf) {
    redirect("/api/auth/csrf?next=/settings/admin/allowlist");
  }

  const params = searchParams ? await searchParams : {};
  const errorMessage = formErrorMessage(params.error);
  await requireAdmin();
  const instances = await services.allowlist.listInstances();
  const projects = await services.allowlist.listProjects();
  const instanceById = new Map(
    instances.map((instance) => [instance.id, instance.baseUrlNormalized]),
  );

  return (
    <AppShell active="allowlist" csrf={csrf}>
      <PageHeader
        title="Danh sách cho phép"
        description="Chỉ những GitLab instance và dự án trong danh sách này mới được ReviewPulse truy cập."
        icon={<IconListCheck size={22} />}
      />

      {errorMessage ? <Alert tone="danger">{errorMessage}</Alert> : null}

      <Card>
        <CardHead
          title="GitLab instance"
          description="URL phải khớp chính xác — tên miền con hoặc cổng khác được xem là instance khác."
          icon={<IconGitBranch size={17} />}
        />
        <CardBody>
          {instances.length === 0 ? (
            <EmptyState
              icon={<IconGitBranch size={22} />}
              title="Chưa có GitLab instance nào"
              description="Thêm URL GitLab đầu tiên để người dùng có thể kết nối PAT."
            />
          ) : (
            <DataTable
              caption="Danh sách GitLab instance được phép"
              columns={INSTANCE_COLUMNS}
            >
              {instances.map((instance) => (
                <tr key={instance.id}>
                  <td className="rp-mono">{instance.baseUrlNormalized}</td>
                  <td>{instance.label ?? <span className="rp-muted">—</span>}</td>
                  <td>
                    <Badge tone={instance.internal ? "warning" : "neutral"}>
                      {instance.internal ? "Mạng nội bộ" : "Công khai"}
                    </Badge>
                  </td>
                  <td>
                    <ConfirmDialog
                      action="/api/admin/allowlist"
                      fields={{
                        csrf,
                        action: "remove_instance",
                        instanceId: instance.id,
                      }}
                      triggerLabel="Xóa"
                      title="Xóa GitLab instance?"
                      description={`${instance.baseUrlNormalized} sẽ bị xóa khỏi danh sách cho phép. Người dùng sẽ không kết nối được tới instance này.`}
                      confirmLabel="Xóa instance"
                    />
                  </td>
                </tr>
              ))}
            </DataTable>
          )}

          <form
            method="post"
            action="/api/admin/allowlist"
            className="rp-form"
            style={{ maxWidth: 620 }}
          >
            <input type="hidden" name="csrf" value={csrf} />
            <input type="hidden" name="action" value="add_instance" />
            <div className="rp-form-grid">
              <Field
                id="instance-url"
                label="GitLab URL"
                required
                help="Ví dụ: https://gitlab.example.com"
              >
                <TextInput
                  id="instance-url"
                  name="baseUrl"
                  required
                  help
                  placeholder="https://gitlab.example.com"
                />
              </Field>
              <Field id="instance-label" label="Nhãn (không bắt buộc)">
                <TextInput
                  id="instance-label"
                  name="label"
                  placeholder="GitLab nội bộ"
                />
              </Field>
            </div>
            <Checkbox
              id="instance-internal"
              name="internal"
              value="true"
              label="Cho phép instance này trỏ vào dải IP nội bộ (RFC1918)"
            />
            <div className="rp-card-actions">
              <Button type="submit" variant="primary">
                <IconPlus size={16} />
                Thêm instance
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHead
          title="Dự án được phép"
          description="Người dùng chỉ bật được dự án có trong danh sách này."
          icon={<IconFolder size={17} />}
        />
        <CardBody>
          {projects.length === 0 ? (
            <EmptyState
              icon={<IconFolder size={22} />}
              title="Chưa có dự án nào được phép"
              description="Thêm dự án theo GitLab project id để người dùng có thể bật theo dõi."
            />
          ) : (
            <DataTable
              caption="Danh sách dự án được phép"
              columns={PROJECT_COLUMNS}
            >
              {projects.map((project) => (
                <tr key={project.id}>
                  <td>
                    <div className="rp-table-primary">
                      {project.pathWithNamespace ?? project.gitlabProjectId}
                    </div>
                    <div className="rp-table-sub">
                      GitLab project id: {project.gitlabProjectId}
                    </div>
                  </td>
                  <td className="rp-mono">
                    {instanceById.get(project.gitlabInstanceId) ??
                      project.gitlabInstanceId}
                  </td>
                  <td>
                    <ConfirmDialog
                      action="/api/admin/allowlist"
                      fields={{
                        csrf,
                        action: "remove_project",
                        id: project.id,
                      }}
                      triggerLabel="Xóa"
                      title="Xóa dự án khỏi danh sách cho phép?"
                      description={`${
                        project.pathWithNamespace ?? project.gitlabProjectId
                      } sẽ không còn được người dùng bật theo dõi.`}
                      confirmLabel="Xóa dự án"
                    />
                  </td>
                </tr>
              ))}
            </DataTable>
          )}

          {instances.length === 0 ? (
            <Alert tone="info">
              Hãy thêm ít nhất một GitLab instance trước khi thêm dự án.
            </Alert>
          ) : (
            <form
              method="post"
              action="/api/admin/allowlist"
              className="rp-form"
              style={{ maxWidth: 620 }}
            >
              <input type="hidden" name="csrf" value={csrf} />
              <input type="hidden" name="action" value="add_project" />
              <div className="rp-form-grid">
                <Field id="project-instance" label="GitLab instance" required>
                  <Select
                    id="project-instance"
                    name="gitlabInstanceId"
                    required
                    defaultValue=""
                  >
                    <option value="" disabled>
                      Chọn instance
                    </option>
                    {instances.map((instance) => (
                      <option key={instance.id} value={instance.id}>
                        {instance.baseUrlNormalized}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field
                  id="project-id"
                  label="GitLab project id"
                  required
                  help="Số id của dự án trên GitLab."
                >
                  <TextInput
                    id="project-id"
                    name="gitlabProjectId"
                    required
                    help
                    placeholder="1234"
                  />
                </Field>
                <Field
                  id="project-path"
                  label="Đường dẫn (không bắt buộc)"
                  help="Dạng group/project, dùng để hiển thị."
                >
                  <TextInput
                    id="project-path"
                    name="pathWithNamespace"
                    help
                    placeholder="nhom/du-an"
                  />
                </Field>
              </div>
              <div className="rp-card-actions">
                <Button type="submit" variant="primary">
                  <IconPlus size={16} />
                  Thêm dự án
                </Button>
              </div>
            </form>
          )}
        </CardBody>
      </Card>
    </AppShell>
  );
}
