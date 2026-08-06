/** Vietnamese labels for backend enums and redirect error codes. */

export const ROLE_LABELS: Record<string, string> = {
  admin: "Quản trị viên",
  tech_lead: "Tech Lead",
  developer: "Developer",
};

export const USER_STATUS_LABELS: Record<string, string> = {
  active: "Đang hoạt động",
  deactivated: "Đã vô hiệu hóa",
};

export const CONNECTION_STATUS_LABELS: Record<string, string> = {
  active: "Đã kết nối",
  invalid: "Thông tin xác thực không hợp lệ",
};

export function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role;
}

export function userStatusLabel(status: string): string {
  return USER_STATUS_LABELS[status] ?? status;
}

export function connectionStatusLabel(status: string): string {
  return CONNECTION_STATUS_LABELS[status] ?? status;
}

/** Maps the `?error=` values the API routes redirect with. */
export function formErrorMessage(code: string | undefined): string | null {
  if (code === undefined || code === "") {
    return null;
  }
  if (code === "unknown_action") {
    return "Hành động không hợp lệ.";
  }
  return "Không thực hiện được yêu cầu. Vui lòng kiểm tra lại thông tin và thử lại.";
}

export function formatDateTime(value: Date | null): string {
  if (value === null) {
    return "—";
  }
  return new Intl.DateTimeFormat("vi-VN", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(value);
}
