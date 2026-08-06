import type { ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";

import {
  IconFolder,
  IconGitBranch,
  IconListCheck,
  IconLogOut,
  IconPulse,
  IconShield,
  IconUsers,
} from "@/components/icons";
import { Button } from "@/components/ui/button";
import { roleLabel } from "@/lib/labels";
import { requireUser } from "@/server/http";

export type NavKey =
  | "security"
  | "gitlab"
  | "projects"
  | "users"
  | "allowlist";

type NavItem = {
  key: NavKey;
  href: string;
  label: string;
  icon: ReactNode;
};

const MAIN_ITEMS: readonly NavItem[] = [
  {
    key: "security",
    href: "/settings/security",
    label: "Bảo mật",
    icon: <IconShield size={17} />,
  },
  {
    key: "gitlab",
    href: "/settings/gitlab",
    label: "GitLab",
    icon: <IconGitBranch size={17} />,
  },
  {
    key: "projects",
    href: "/settings/projects",
    label: "Dự án",
    icon: <IconFolder size={17} />,
  },
];

const ADMIN_ITEMS: readonly NavItem[] = [
  {
    key: "users",
    href: "/settings/admin/users",
    label: "Người dùng",
    icon: <IconUsers size={17} />,
  },
  {
    key: "allowlist",
    href: "/settings/admin/allowlist",
    label: "Danh sách cho phép",
    icon: <IconListCheck size={17} />,
  },
];

function NavGroup({
  label,
  items,
  active,
}: {
  label: string;
  items: readonly NavItem[];
  active: NavKey;
}) {
  return (
    <div>
      <p className="rp-nav-group-label">{label}</p>
      <ul className="rp-nav-list">
        {items.map((item) => (
          <li key={item.key}>
            <Link
              href={item.href}
              className="rp-nav-item"
              aria-current={item.key === active ? "page" : undefined}
            >
              {item.icon}
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Dashboard frame: sidebar navigation plus the signed-in user card. Requires a
 * valid session; anonymous callers are sent to the sign-in page.
 */
export async function AppShell({
  active,
  csrf,
  children,
}: {
  active: NavKey;
  csrf: string;
  children: ReactNode;
}) {
  let user;
  try {
    ({ user } = await requireUser());
  } catch {
    redirect("/login");
  }

  const isAdmin = user.role === "admin";

  return (
    <div className="rp-shell">
      <aside className="rp-sidebar">
        <Link href="/settings/security" className="rp-brand">
          <span className="rp-brand-mark" aria-hidden="true">
            <IconPulse size={19} />
          </span>
          ReviewPulse
        </Link>

        <nav className="rp-nav" aria-label="Điều hướng chính">
          <NavGroup label="Chính" items={MAIN_ITEMS} active={active} />
          {isAdmin ? (
            <NavGroup label="Quản trị" items={ADMIN_ITEMS} active={active} />
          ) : null}
        </nav>

        <div className="rp-sidebar-footer">
          <div className="rp-user">
            <span className="rp-avatar" aria-hidden="true">
              {user.email.slice(0, 1)}
            </span>
            <div className="rp-user-meta">
              <div className="rp-user-name" title={user.email}>
                {user.email}
              </div>
              <div className="rp-user-role">{roleLabel(user.role)}</div>
            </div>
          </div>
          <form method="post" action="/api/auth/logout">
            <input type="hidden" name="csrf" value={csrf} />
            <Button type="submit" variant="ghost" size="sm" block>
              <IconLogOut size={16} />
              Đăng xuất
            </Button>
          </form>
        </div>
      </aside>

      <main className="rp-main">
        <div className="rp-main-inner">{children}</div>
      </main>
    </div>
  );
}
