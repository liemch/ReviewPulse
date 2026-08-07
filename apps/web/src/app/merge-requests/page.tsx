import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import { AppShell } from "@/components/layout/app-shell";
import { IconGitBranch, IconLink } from "@/components/icons";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHead } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Select, TextInput } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { DataTable } from "@/components/ui/table";
import { formatDateTime } from "@/lib/labels";
import { requireUser } from "@/server/http";
import { getServices } from "@/server/services";

export const runtime = "nodejs";

const COLUMNS = [
  "Dự án",
  "IID",
  "Tiêu đề",
  "Tác giả",
  "Reviewer",
  "Trạng thái",
  "Cập nhật",
  "GitLab",
];

function stateBadge(state: string): "success" | "warning" | "neutral" | "danger" {
  if (state === "merged") return "success";
  if (state === "opened") return "warning";
  if (state === "closed") return "neutral";
  return "danger";
}

export default async function MergeRequestsPage({
  searchParams,
}: {
  searchParams?: Promise<{
    projectKey?: string;
    state?: string;
    author?: string;
    reviewer?: string;
    error?: string;
  }>;
}) {
  const services = getServices();
  const jar = await cookies();
  const csrf = jar.get(services.policy.csrfCookieName)?.value;
  if (!csrf) {
    redirect("/api/auth/csrf?next=/merge-requests");
  }

  const params = searchParams ? await searchParams : {};
  const { user } = await requireUser();

  const projects = (await services.projects.listForUser(user.id)).filter(
    (p) => p.enabled && p.gitlabVisible && p.error === null,
  );

  const stateRaw = (params.state ?? "opened").trim();
  const state =
    stateRaw === "opened" ||
    stateRaw === "closed" ||
    stateRaw === "merged" ||
    stateRaw === "all"
      ? stateRaw
      : "opened";

  const author =
    params.author && params.author.trim().length > 0
      ? params.author.trim()
      : undefined;
  const reviewer =
    params.reviewer && params.reviewer.trim().length > 0
      ? params.reviewer.trim()
      : undefined;

  let gitlabInstanceId: string | undefined;
  let gitlabProjectId: string | undefined;
  const projectKey = (params.projectKey ?? "").trim();
  if (projectKey.includes(":")) {
    const sep = projectKey.indexOf(":");
    const instanceId = projectKey.slice(0, sep);
    const projectId = projectKey.slice(sep + 1);
    const allowed = projects.some(
      (p) =>
        p.gitlabInstanceId === instanceId && p.gitlabProjectId === projectId,
    );
    if (allowed) {
      gitlabInstanceId = instanceId;
      gitlabProjectId = projectId;
    }
  }

  const items = await services.mrWorkspace.list(user.id, {
    ...(gitlabInstanceId === undefined ? {} : { gitlabInstanceId }),
    ...(gitlabProjectId === undefined ? {} : { gitlabProjectId }),
    state,
    ...(author === undefined ? {} : { authorUsername: author }),
    ...(reviewer === undefined ? {} : { reviewerUsername: reviewer }),
  });

  const selectedKey =
    gitlabInstanceId && gitlabProjectId
      ? `${gitlabInstanceId}:${gitlabProjectId}`
      : "";

  return (
    <AppShell active="merge-requests" csrf={csrf}>
      <PageHeader
        title="Review Merge Request"
        description="Danh sách MR live từ GitLab theo dự án bạn đã bật và có quyền truy cập."
        icon={<IconGitBranch size={22} />}
      />

      {params.error === "not_found" ? (
        <Alert tone="warning">
          Không tìm thấy Merge Request hoặc bạn không có quyền truy cập.
        </Alert>
      ) : null}

      <Card>
        <CardHead
          title="Bộ lọc"
          description="Lọc theo dự án đã ủy quyền — không tải MR toàn cục rồi lọc frontend."
        />
        <CardBody>
          <form method="get" className="rp-form">
            <div className="rp-form-grid">
              <Field id="projectKey" label="Dự án">
                <Select id="projectKey" name="projectKey" defaultValue={selectedKey}>
                  <option value="">Tất cả dự án đã bật</option>
                  {projects.map((p) => (
                    <option
                      key={`${p.gitlabInstanceId}:${p.gitlabProjectId}`}
                      value={`${p.gitlabInstanceId}:${p.gitlabProjectId}`}
                    >
                      {p.pathWithNamespace ?? p.gitlabProjectId}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field id="state" label="Trạng thái">
                <Select id="state" name="state" defaultValue={state}>
                  <option value="opened">Đang mở</option>
                  <option value="merged">Đã merge</option>
                  <option value="closed">Đã đóng</option>
                  <option value="all">Tất cả</option>
                </Select>
              </Field>
              <Field id="author" label="Tác giả (username)">
                <TextInput
                  id="author"
                  name="author"
                  defaultValue={author ?? ""}
                  placeholder="vd. alice"
                />
              </Field>
              <Field id="reviewer" label="Reviewer (username)">
                <TextInput
                  id="reviewer"
                  name="reviewer"
                  defaultValue={reviewer ?? ""}
                  placeholder="vd. bob"
                />
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
          title="Merge Request"
          description={`${items.length} kết quả (live GitLab)`}
        />
        <CardBody>
          {items.length === 0 ? (
            <EmptyState
              title="Không có Merge Request"
              description="Không có MR nào trong phạm vi dự án đã ủy quyền với bộ lọc hiện tại."
            />
          ) : (
            <DataTable caption="Danh sách Merge Request" columns={COLUMNS}>
              {items.map((row) => (
                <tr
                  key={`${row.gitlabInstanceId}:${row.gitlabProjectId}:${row.iid}`}
                >
                  <td>
                    <div className="rp-table-primary">
                      {row.pathWithNamespace ?? row.gitlabProjectId}
                    </div>
                  </td>
                  <td>
                    <Link
                      href={`/merge-requests/${row.gitlabInstanceId}/${row.gitlabProjectId}/${row.iid}`}
                      className="rp-link"
                    >
                      !{row.iid}
                    </Link>
                  </td>
                  <td>
                    <Link
                      href={`/merge-requests/${row.gitlabInstanceId}/${row.gitlabProjectId}/${row.iid}`}
                      className="rp-link"
                    >
                      {row.title || "(không tiêu đề)"}
                    </Link>
                  </td>
                  <td>{row.authorUsername ?? "—"}</td>
                  <td>
                    {row.reviewers.length > 0 ? row.reviewers.join(", ") : "—"}
                  </td>
                  <td>
                    <Badge tone={stateBadge(row.state)}>{row.state}</Badge>
                  </td>
                  <td>{formatDateTime(new Date(row.updatedAt))}</td>
                  <td>
                    {row.webUrl ? (
                      <a
                        href={row.webUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="rp-link"
                      >
                        <IconLink size={14} /> GitLab
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
