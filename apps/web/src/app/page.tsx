import { IconPulse } from "@/components/icons";
import { ButtonLink } from "@/components/ui/button";

export default function HomePage() {
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
          <h1 className="rp-auth-title">Theo dõi KPI GitLab</h1>
          <p className="rp-auth-desc">
            Công cụ nội bộ giúp đội phát triển theo dõi hoạt động Merge Request
            và commit trên GitLab. Chỉ đọc dữ liệu, không thay đổi gì trên
            GitLab.
          </p>
        </div>
        <ButtonLink href="/login" variant="primary" block>
          Đăng nhập
        </ButtonLink>
      </div>

      <p className="rp-auth-foot">
        Tài khoản chỉ được cấp bởi quản trị viên.
      </p>
    </div>
  );
}
