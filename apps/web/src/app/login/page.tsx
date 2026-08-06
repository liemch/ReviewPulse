import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { IconPulse } from "@/components/icons";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, TextInput } from "@/components/ui/field";
import { getServices } from "@/server/services";

export const runtime = "nodejs";

export default async function LoginPage({
  searchParams,
}: {
  searchParams?: Promise<{ error?: string }>;
}) {
  const params = searchParams ? await searchParams : {};
  const services = getServices();
  const jar = await cookies();
  const csrf = jar.get(services.policy.csrfCookieName)?.value;
  if (!csrf) {
    redirect("/api/auth/csrf?next=/login");
  }

  return (
    <div className="rp-auth">
      <div className="rp-brand">
        <span className="rp-brand-mark" aria-hidden="true">
          <IconPulse size={19} />
        </span>
        ReviewPulse
      </div>

      <div className="rp-auth-card">
        <div className="rp-auth-head">
          <h1 className="rp-auth-title">Đăng nhập</h1>
          <p className="rp-auth-desc">Đăng nhập để sử dụng ReviewPulse.</p>
        </div>

        {params.error ? (
          <div style={{ marginBottom: "var(--rp-space-4)" }}>
            <Alert tone="danger" title="Đăng nhập không thành công">
              Email hoặc mật khẩu không đúng. Vui lòng thử lại.
            </Alert>
          </div>
        ) : null}

        <form method="post" action="/api/auth/login" className="rp-form">
          <input type="hidden" name="csrf" value={csrf} />
          <Field id="email" label="Email" required>
            <TextInput
              id="email"
              name="email"
              type="email"
              required
              autoComplete="username"
              placeholder="ten@congty.com"
            />
          </Field>
          <Field id="password" label="Mật khẩu" required>
            <TextInput
              id="password"
              name="password"
              type="password"
              required
              autoComplete="current-password"
            />
          </Field>
          <Button type="submit" variant="primary" block>
            Đăng nhập
          </Button>
        </form>
      </div>

      <p className="rp-auth-foot">
        Tài khoản chỉ được cấp bởi quản trị viên — hệ thống không cho phép tự
        đăng ký.
      </p>
    </div>
  );
}
