import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { AppShell } from "@/components/layout/app-shell";
import { IconClock, IconLogOut, IconShield } from "@/components/icons";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHead } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { requireUser } from "@/server/http";
import { getServices } from "@/server/services";
import { formErrorMessage } from "@/lib/labels";

export const runtime = "nodejs";

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
    </AppShell>
  );
}
