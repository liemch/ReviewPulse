import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { AppShell } from "@/components/layout/app-shell";
import { IconClock, IconLogOut, IconPlus, IconShield } from "@/components/icons";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHead } from "@/components/ui/card";
import { Field, TextInput } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { DataTable } from "@/components/ui/table";
import { requireUser } from "@/server/http";
import { getServices } from "@/server/services";
import { formErrorMessage } from "@/lib/labels";

export const runtime = "nodejs";

const EMAIL_COLUMNS = ["Email", "Nguồn", "Xác minh", "Hành động"];

function sourceLabel(source: string): string {
  if (source === "user_alias") return "Alias tự thêm";
  if (source === "gitlab_primary") return "GitLab chính";
  if (source === "gitlab_secondary") return "GitLab phụ";
  return source;
}

function verificationLabel(status: string): string {
  if (status === "gitlab_verified") return "GitLab đã xác minh";
  if (status === "gitlab_unverified") return "GitLab chưa xác minh";
  if (status === "user_unverified") return "Chưa xác minh";
  return status;
}

export default async function SecuritySettingsPage({
  searchParams,
}: {
  searchParams?: Promise<{ error?: string }>;
}) {
  const services = getServices();
  const jar = await cookies();
  const csrf = jar.get(services.policy.csrfCookieName)?.value;
  if (!csrf) {
    redirect("/api/auth/csrf?next=/settings/security");
  }

  const params = searchParams ? await searchParams : {};
  const errorMessage = formErrorMessage(params.error);
  const { user } = await requireUser();
  const absHours = Math.round(services.policy.absTtlSeconds / 3600);
  const idleMinutes = Math.round(services.policy.idleTtlSeconds / 60);
  const emails = await services.emails.listForUser(user.id);

  return (
    <AppShell active="security" csrf={csrf}>
      <PageHeader
        title="Bảo mật"
        description="Quản lý phiên đăng nhập và thiết lập bảo mật."
        icon={<IconShield size={22} />}
      />

      {errorMessage ? <Alert tone="danger">{errorMessage}</Alert> : null}

      <Alert tone="success" title="Bạn đang đăng nhập với">
        {user.email}
      </Alert>

      <Card>
        <CardHead
          title="Thông tin phiên"
          description="Chính sách phiên đăng nhập áp dụng cho toàn bộ tài khoản."
          icon={<IconClock size={17} />}
        />
        <CardBody>
          <div className="rp-stats">
            <div className="rp-stat">
              <div>
                <div className="rp-stat-label">Thời hạn tối đa</div>
                <div className="rp-stat-value">{absHours} giờ</div>
                <div className="rp-stat-hint">
                  Phiên hết hạn sau khoảng thời gian này, kể cả khi đang dùng.
                </div>
              </div>
              <span className="rp-stat-icon">
                <IconClock size={17} />
              </span>
            </div>
            <div className="rp-stat">
              <div>
                <div className="rp-stat-label">Thời gian không hoạt động</div>
                <div className="rp-stat-value">{idleMinutes} phút</div>
                <div className="rp-stat-hint">
                  Không hoạt động quá lâu sẽ tự động đăng xuất.
                </div>
              </div>
              <span className="rp-stat-icon">
                <IconClock size={17} />
              </span>
            </div>
          </div>

          <Alert tone="info">
            Hệ thống chưa hỗ trợ liệt kê chi tiết từng phiên đăng nhập. Bạn có
            thể thu hồi toàn bộ phiên nếu nghi ngờ tài khoản bị truy cập trái
            phép.
          </Alert>

          <div className="rp-card-actions">
            <form method="post" action="/api/auth/sessions/revoke-all">
              <input type="hidden" name="csrf" value={csrf} />
              <Button type="submit" variant="danger">
                Thu hồi tất cả phiên đăng nhập
              </Button>
            </form>
            <form method="post" action="/api/auth/logout">
              <input type="hidden" name="csrf" value={csrf} />
              <Button type="submit" variant="secondary">
                <IconLogOut size={16} />
                Đăng xuất
              </Button>
            </form>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHead
          title="Email liên kết"
          description="Dùng để khớp tác giả commit/MR trên dashboard. Alias chưa xác minh chỉ để liên kết — không phải danh tính KPI đã xác nhận."
          icon={<IconShield size={17} />}
        />
        <CardBody>
          {emails.length === 0 ? (
            <Alert tone="info">
              Chưa có email nào. Kết nối GitLab hoặc thêm alias bên dưới.
            </Alert>
          ) : (
            <DataTable caption="Email của bạn" columns={EMAIL_COLUMNS}>
              {emails.map((email) => (
                <tr key={email.id}>
                  <td>
                    <div className="rp-table-primary">{email.email}</div>
                    {email.isPrimary ? (
                      <Badge tone="accent">Chính</Badge>
                    ) : null}
                  </td>
                  <td>{sourceLabel(email.source)}</td>
                  <td>
                    <Badge
                      tone={
                        email.verificationStatus === "gitlab_verified"
                          ? "success"
                          : "warning"
                      }
                    >
                      {verificationLabel(email.verificationStatus)}
                    </Badge>
                  </td>
                  <td>
                    {email.source === "user_alias" ? (
                      <form method="post" action="/api/settings/emails">
                        <input type="hidden" name="csrf" value={csrf} />
                        <input type="hidden" name="action" value="remove" />
                        <input type="hidden" name="emailId" value={email.id} />
                        <Button type="submit" variant="secondary" size="sm">
                          Xóa
                        </Button>
                      </form>
                    ) : (
                      <span className="rp-muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </DataTable>
          )}

          <form
            method="post"
            action="/api/settings/emails"
            className="rp-form"
            style={{ maxWidth: 480, marginTop: 16 }}
          >
            <input type="hidden" name="csrf" value={csrf} />
            <input type="hidden" name="action" value="add" />
            <Field
              id="alias-email"
              label="Thêm alias email"
              help="Email chưa xác minh — chỉ dùng để khớp dữ liệu GitLab."
            >
              <TextInput
                id="alias-email"
                name="email"
                type="email"
                required
                help
                placeholder="ban@example.com"
              />
            </Field>
            <div className="rp-card-actions">
              <Button type="submit" variant="primary">
                <IconPlus size={16} />
                Thêm alias
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>
    </AppShell>
  );
}
