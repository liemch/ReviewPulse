import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { AppShell } from "@/components/layout/app-shell";
import { IconPlus, IconUsers } from "@/components/icons";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHead } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field, Select, TextInput } from "@/components/ui/field";
import { DataTable } from "@/components/ui/table";
import { PageHeader } from "@/components/ui/page-header";
import { formErrorMessage, roleLabel, userStatusLabel } from "@/lib/labels";
import { requireAdmin } from "@/server/http";
import { getServices } from "@/server/services";

export const runtime = "nodejs";

const COLUMNS = ["Email", "Vai trò", "Trạng thái", "Hành động"];

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams?: Promise<{ error?: string }>;
}) {
  const services = getServices();
  const jar = await cookies();
  const csrf = jar.get(services.policy.csrfCookieName)?.value;
  if (!csrf) {
    redirect("/api/auth/csrf?next=/settings/admin/users");
  }

  const params = searchParams ? await searchParams : {};
  const errorMessage = formErrorMessage(params.error);
  const { user: actor } = await requireAdmin();
  const users = await services.users.listUsers(actor);

  return (
    <AppShell active="users" csrf={csrf}>
      <PageHeader
        title="Người dùng"
        description="Tạo tài khoản, đặt lại mật khẩu và vô hiệu hóa người dùng."
        icon={<IconUsers size={22} />}
      />

      {errorMessage ? <Alert tone="danger">{errorMessage}</Alert> : null}

      <Card>
        <CardHead
          title="Danh sách người dùng"
          description={`Tổng cộng ${users.length} tài khoản.`}
          icon={<IconUsers size={17} />}
        />
        <CardBody>
          <DataTable caption="Danh sách người dùng" columns={COLUMNS}>
            {users.map((user) => (
              <tr key={user.id}>
                <td>
                  <div className="rp-table-primary">{user.email}</div>
                  {user.id === actor.id ? (
                    <div className="rp-table-sub">Tài khoản của bạn</div>
                  ) : null}
                </td>
                <td>
                  <Badge tone={user.role === "admin" ? "accent" : "neutral"}>
                    {roleLabel(user.role)}
                  </Badge>
                </td>
                <td>
                  <Badge
                    tone={user.status === "active" ? "success" : "neutral"}
                  >
                    {userStatusLabel(user.status)}
                  </Badge>
                </td>
                <td>
                  {user.status === "active" ? (
                    <div className="rp-table-actions">
                      <form
                        method="post"
                        action="/api/admin/users"
                        className="rp-table-actions"
                      >
                        <input type="hidden" name="csrf" value={csrf} />
                        <input
                          type="hidden"
                          name="action"
                          value="reset_password"
                        />
                        <input type="hidden" name="userId" value={user.id} />
                        <input
                          className="rp-input"
                          style={{ width: 190 }}
                          name="password"
                          type="password"
                          required
                          minLength={12}
                          autoComplete="new-password"
                          placeholder="Mật khẩu mới"
                          aria-label={`Mật khẩu mới cho ${user.email}`}
                        />
                        <Button type="submit" variant="secondary" size="sm">
                          Đặt lại mật khẩu
                        </Button>
                      </form>
                      {user.id === actor.id ? null : (
                        <ConfirmDialog
                          action="/api/admin/users"
                          fields={{
                            csrf,
                            action: "deactivate",
                            userId: user.id,
                          }}
                          triggerLabel="Vô hiệu hóa"
                          title="Vô hiệu hóa người dùng?"
                          description={`${user.email} sẽ không thể đăng nhập và mọi phiên hiện tại sẽ bị thu hồi.`}
                          confirmLabel="Vô hiệu hóa"
                        />
                      )}
                    </div>
                  ) : (
                    <span className="rp-muted">—</span>
                  )}
                </td>
              </tr>
            ))}
          </DataTable>
        </CardBody>
      </Card>

      <Card>
        <CardHead
          title="Tạo người dùng"
          description="Không có đăng ký công khai — quản trị viên cấp tài khoản và mật khẩu tạm."
          icon={<IconPlus size={17} />}
        />
        <CardBody>
          <form
            method="post"
            action="/api/admin/users"
            className="rp-form"
            style={{ maxWidth: 620 }}
          >
            <input type="hidden" name="csrf" value={csrf} />
            <input type="hidden" name="action" value="create" />
            <div className="rp-form-grid">
              <Field id="new-email" label="Email" required>
                <TextInput
                  id="new-email"
                  name="email"
                  type="email"
                  required
                  placeholder="ten@congty.com"
                />
              </Field>
              <Field
                id="new-password"
                label="Mật khẩu tạm"
                required
                help="Tối thiểu 12 ký tự. Hãy gửi cho người dùng qua kênh an toàn."
              >
                <TextInput
                  id="new-password"
                  name="password"
                  type="password"
                  required
                  help
                  minLength={12}
                  autoComplete="new-password"
                />
              </Field>
              <Field id="new-role" label="Vai trò">
                <Select id="new-role" name="role" defaultValue="developer">
                  <option value="developer">Developer</option>
                  <option value="tech_lead">Tech Lead</option>
                  <option value="admin">Quản trị viên</option>
                </Select>
              </Field>
            </div>
            <div className="rp-card-actions">
              <Button type="submit" variant="primary">
                <IconPlus size={16} />
                Tạo người dùng
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>
    </AppShell>
  );
}
