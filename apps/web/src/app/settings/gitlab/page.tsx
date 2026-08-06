import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { AppShell } from "@/components/layout/app-shell";
import {
  IconGitBranch,
  IconKey,
  IconLink,
  IconRefresh,
  IconTrash,
} from "@/components/icons";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHead } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, TextInput } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import {
  connectionStatusLabel,
  formatDateTime,
  formErrorMessage,
} from "@/lib/labels";
import { requireUser } from "@/server/http";
import { getServices } from "@/server/services";

export const runtime = "nodejs";

export default async function GitLabSettingsPage({
  searchParams,
}: {
  searchParams?: Promise<{ error?: string; tested?: string }>;
}) {
  const services = getServices();
  const jar = await cookies();
  const csrf = jar.get(services.policy.csrfCookieName)?.value;
  if (!csrf) {
    redirect("/api/auth/csrf?next=/settings/gitlab");
  }

  const params = searchParams ? await searchParams : {};
  const errorMessage = formErrorMessage(params.error);
  const { user } = await requireUser();
  const connections = await services.connections.listForUser(user.id);

  return (
    <AppShell active="gitlab" csrf={csrf}>
      <PageHeader
        title="Kết nối GitLab"
        description="Dùng Personal Access Token (PAT) cá nhân với quyền read_api để ReviewPulse đọc dữ liệu thay bạn."
        icon={<IconGitBranch size={22} />}
      />

      {errorMessage ? <Alert tone="danger">{errorMessage}</Alert> : null}
      {params.tested ? (
        <Alert tone="success" title="Token hợp lệ">
          ReviewPulse đã xác thực được PAT với GitLab.
        </Alert>
      ) : null}

      <Card>
        <CardHead
          title="Trạng thái kết nối"
          description="Mỗi người dùng tự quản lý kết nối GitLab của mình."
          icon={<IconLink size={17} />}
        />
        <CardBody>
          {connections.length === 0 ? (
            <EmptyState
              icon={<IconGitBranch size={22} />}
              title="Chưa kết nối GitLab"
              description="Nhập URL GitLab đã được phép và PAT của bạn ở phần bên dưới để bắt đầu."
            />
          ) : (
            <ul className="rp-stack">
              {connections.map((connection) => (
                <li key={connection.id} className="rp-stat">
                  <div>
                    <div className="rp-row">
                      <strong className="rp-mono">
                        {connection.baseUrlNormalized}
                      </strong>
                      <Badge
                        tone={
                          connection.status === "active" ? "success" : "danger"
                        }
                      >
                        {connectionStatusLabel(connection.status)}
                      </Badge>
                    </div>
                    <p className="rp-help">
                      Tài khoản GitLab: @{connection.gitlabUsername}
                      {connection.patHintLast4
                        ? ` · PAT …${connection.patHintLast4}`
                        : ""}
                    </p>
                    <p className="rp-help">
                      Kiểm tra gần nhất:{" "}
                      {formatDateTime(connection.lastValidatedAt)}
                    </p>
                    <div
                      className="rp-table-actions"
                      style={{ marginTop: "var(--rp-space-3)" }}
                    >
                      <form method="post" action="/api/settings/gitlab">
                        <input type="hidden" name="csrf" value={csrf} />
                        <input
                          type="hidden"
                          name="connectionId"
                          value={connection.id}
                        />
                        <Button
                          type="submit"
                          name="action"
                          value="retest"
                          variant="secondary"
                          size="sm"
                        >
                          <IconRefresh size={15} />
                          Kiểm tra lại
                        </Button>
                      </form>
                      <ConfirmDialog
                        action="/api/settings/gitlab"
                        fields={{
                          csrf,
                          action: "delete",
                          connectionId: connection.id,
                        }}
                        triggerLabel="Xóa kết nối"
                        triggerIcon={<IconTrash size={15} />}
                        title="Xóa kết nối GitLab?"
                        description={`Kết nối tới ${connection.baseUrlNormalized} sẽ bị xóa và PAT đã lưu sẽ bị hủy. Bạn có thể kết nối lại sau.`}
                        confirmLabel="Xóa kết nối"
                      />
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHead
          title="Thêm hoặc thay thế PAT"
          description="Chỉ chấp nhận URL GitLab nằm trong danh sách cho phép."
          icon={<IconKey size={17} />}
        />
        <CardBody>
          <form
            method="post"
            action="/api/settings/gitlab"
            className="rp-form"
            style={{ maxWidth: 520 }}
          >
            <input type="hidden" name="csrf" value={csrf} />
            <input type="hidden" name="action" value="save" />
            <Field
              id="baseUrl"
              label="GitLab URL"
              required
              help="Nhập đúng origin, ví dụ https://gitlab.example.com (không thêm đường dẫn phía sau)."
            >
              <TextInput
                id="baseUrl"
                name="baseUrl"
                required
                help
                placeholder="https://gitlab.example.com"
              />
            </Field>
            <Field
              id="pat"
              label="Personal Access Token (PAT)"
              required
              help="Chỉ cần quyền read_api. Token được mã hóa khi lưu và không hiển thị lại — về sau bạn chỉ thấy 4 ký tự cuối."
            >
              <TextInput
                id="pat"
                name="pat"
                type="password"
                required
                help
                autoComplete="off"
              />
            </Field>
            <div className="rp-card-actions">
              <Button type="submit" variant="primary">
                Lưu kết nối
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>
    </AppShell>
  );
}
