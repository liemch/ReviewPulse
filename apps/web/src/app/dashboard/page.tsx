import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { AppShell } from "@/components/layout/app-shell";
import {
  IconAlertCircle,
  IconGitBranch,
  IconInbox,
  IconLink,
  IconPulse,
} from "@/components/icons";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHead } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Select, TextInput } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { DataTable } from "@/components/ui/table";
import { formatDateTime } from "@/lib/labels";
import { requireUser } from "@/server/http";
import { getServices } from "@/server/services";

export const runtime = "nodejs";

const COMMIT_COLUMNS = ["Commit", "Tác giả", "Thời gian", "GitLab"];
const MR_COLUMNS = ["Merge Request", "Trạng thái", "Tác giả", "Cập nhật", "GitLab"];

const METRIC_LABELS: Record<string, string> = {
  commit_frequency: "Tần suất commit / tuần",
  ai_assisted_commits: "Commit khai báo có AI hỗ trợ",
  loc_weekly: "LOC / tuần",
  mr_size: "Kích thước Merge Request",
};

function parseDateParam(raw: string | undefined): Date | undefined {
  if (!raw || raw.trim().length === 0) {
    return undefined;
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function toInputDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function formatMetricValue(
  value: number | null,
  status: string,
  unit: string | null,
): string {
  if (status === "not_configured" || value === null) {
    return "Chưa cấu hình";
  }
  return unit ? `${value} ${unit}` : String(value);
}

function verificationLabel(status: string): string {
  if (status.startsWith("gitlab_verified")) return "Đã xác minh GitLab";
  if (status.includes("unverified")) return "Chưa xác minh";
  return status;
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams?: Promise<{
    from?: string;
    to?: string;
    author?: string;
  }>;
}) {
  const services = getServices();
  const jar = await cookies();
  const csrf = jar.get(services.policy.csrfCookieName)?.value;
  if (!csrf) {
    redirect("/api/auth/csrf?next=/dashboard");
  }

  const params = searchParams ? await searchParams : {};
  const { user } = await requireUser();
  const from = parseDateParam(params.from);
  const to = parseDateParam(params.to);
  const author =
    params.author && params.author.trim().length > 0
      ? params.author.trim().toLowerCase()
      : null;

  const data = await services.dashboard.query(user.id, {
    from,
    to,
    authorEmailNormalized: author,
  });

  const connections = await services.connections.listForUser(user.id);

  return (
    <AppShell active="dashboard" csrf={csrf}>
      <PageHeader
        title="Tổng quan"
        description="Hoạt động commit và Merge Request từ GitLab — dữ liệu tham chiếu, không phải điểm KPI."
        icon={<IconPulse size={22} />}
      />

      <Alert tone="info" title="Lưu ý">
        ReviewPulse cung cấp dữ liệu hỗ trợ đối soát. Quyết định KPI cuối cùng
        thuộc quy trình đánh giá của công ty.
      </Alert>

      {connections.length === 0 ? (
        <EmptyState
          icon={<IconGitBranch size={22} />}
          title="Chưa kết nối GitLab"
          description="Kết nối PAT để ReviewPulse đồng bộ và hiển thị hoạt động."
          action={
            <ButtonLink href="/settings/gitlab" variant="primary">
              Kết nối GitLab
            </ButtonLink>
          }
        />
      ) : data.authorizedProjects.length === 0 ? (
        <EmptyState
          icon={<IconInbox size={22} />}
          title="Chưa có dự án được theo dõi"
          description="Bật ít nhất một dự án trong danh sách cho phép mà PAT của bạn nhìn thấy."
          action={
            <ButtonLink href="/settings/projects" variant="primary">
              Quản lý dự án
            </ButtonLink>
          }
        />
      ) : null}

      <Card>
        <CardHead
          title="Bộ lọc"
          description="Lọc theo khoảng thời gian và email tác giả đã cấu hình."
        />
        <CardBody>
          <form method="get" action="/dashboard" className="rp-form">
            <div className="rp-form-grid">
              <Field id="from" label="Từ ngày">
                <TextInput
                  id="from"
                  name="from"
                  type="date"
                  defaultValue={toInputDate(data.windowStart)}
                />
              </Field>
              <Field id="to" label="Đến ngày">
                <TextInput
                  id="to"
                  name="to"
                  type="date"
                  defaultValue={toInputDate(
                    new Date(data.windowEnd.getTime() - 1),
                  )}
                />
              </Field>
              <Field id="author" label="Email tác giả">
                <Select id="author" name="author" defaultValue={author ?? ""}>
                  <option value="">Tất cả email của tôi</option>
                  {data.emails.map((email) => (
                    <option
                      key={email.normalizedEmail}
                      value={email.normalizedEmail}
                    >
                      {email.email} ({verificationLabel(email.verificationStatus)})
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <div className="rp-card-actions">
              <Button type="submit" variant="primary">
                Áp dụng
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHead
          title="Chỉ số tham chiếu"
          description="Số liệu quan sát + khoảng tham chiếu. Không có điểm, hạng, đạt/không đạt."
          icon={<IconPulse size={17} />}
        />
        <CardBody>
          <div className="rp-stats">
            {data.metrics.map((metric) => (
              <div className="rp-stat" key={metric.metric}>
                <div>
                  <div className="rp-stat-label">
                    {METRIC_LABELS[metric.metric] ?? metric.metric}
                  </div>
                  <div className="rp-stat-value">
                    {formatMetricValue(
                      metric.value,
                      metric.status,
                      metric.unit,
                    )}
                  </div>
                  <div className="rp-stat-hint">
                    {metric.reference_range.min !== null ||
                    metric.reference_range.max !== null
                      ? `Tham chiếu: ${metric.reference_range.min ?? "—"}–${metric.reference_range.max ?? "—"}`
                      : metric.reference_policy_note ??
                        `Nguồn: ${metric.source} · ${metric.rule_version}`}
                    {metric.verification_status
                      ? ` · ${metric.verification_status}`
                      : ""}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </CardBody>
      </Card>

      {data.mismatchCount > 0 ? (
        <Alert tone="warning" title="Email không khớp">
          Có {data.mismatchCount} dòng có email tác giả không nằm trong danh
          sách email đã cấu hình của bạn. Các alias chưa xác minh chỉ dùng để
          liên kết — không được coi là danh tính KPI đã xác nhận.{" "}
          <a href="/settings/security">Quản lý email</a>
        </Alert>
      ) : null}

      <Card>
        <CardHead
          title="Commit gần đây"
          description={`Cửa sổ ${formatDateTime(data.windowStart)} → ${formatDateTime(data.windowEnd)}`}
        />
        <CardBody>
          {data.commits.length === 0 ? (
            <EmptyState
              title="Không có commit trong khoảng đã chọn"
              description="Thử mở rộng bộ lọc hoặc đợi worker đồng bộ."
            />
          ) : (
            <DataTable caption="Danh sách commit" columns={COMMIT_COLUMNS}>
              {data.commits.map((row) => (
                <tr
                  key={`${row.gitlabInstanceId}:${row.gitlabProjectId}:${row.sha}`}
                >
                  <td>
                    <div className="rp-table-primary">
                      {row.title ?? row.sha.slice(0, 8)}
                    </div>
                    <div className="rp-table-sub">
                      {row.gitlabProjectId} · {row.sha.slice(0, 8)}
                    </div>
                    {row.emailMismatch ? (
                      <Badge tone="warning">Email lệch</Badge>
                    ) : null}
                  </td>
                  <td>{row.authorEmail ?? "—"}</td>
                  <td>{formatDateTime(row.authoredAt)}</td>
                  <td>
                    {row.webUrl ? (
                      <a
                        href={row.webUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="rp-mono"
                      >
                        <IconLink size={14} /> Mở
                      </a>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </DataTable>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHead
          title="Merge Request"
          description="Thuật ngữ GitLab: Merge Request (không dùng Pull Request)."
          icon={<IconGitBranch size={17} />}
        />
        <CardBody>
          {data.mergeRequests.all.length === 0 ? (
            <EmptyState
              icon={<IconAlertCircle size={22} />}
              title="Không có Merge Request trong khoảng đã chọn"
              description="Worker đồng bộ MR theo updated_after."
            />
          ) : (
            <DataTable caption="Danh sách Merge Request" columns={MR_COLUMNS}>
              {data.mergeRequests.all.map((row) => (
                <tr
                  key={`${row.gitlabInstanceId}:${row.gitlabProjectId}:${row.iid}`}
                >
                  <td>
                    <div className="rp-table-primary">
                      !{row.iid} {row.title ?? ""}
                    </div>
                    <div className="rp-table-sub">
                      project {row.gitlabProjectId}
                    </div>
                    {row.emailMismatch ? (
                      <Badge tone="warning">Email lệch</Badge>
                    ) : null}
                  </td>
                  <td>
                    <Badge
                      tone={
                        row.state === "merged"
                          ? "success"
                          : row.state === "opened" || row.state === "open"
                            ? "accent"
                            : "neutral"
                      }
                    >
                      {row.state ?? "—"}
                    </Badge>
                  </td>
                  <td>{row.authorEmail ?? "—"}</td>
                  <td>{formatDateTime(row.updatedAt)}</td>
                  <td>
                    {row.webUrl ? (
                      <a
                        href={row.webUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="rp-mono"
                      >
                        <IconLink size={14} /> Mở
                      </a>
                    ) : (
                      "—"
                    )}
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
