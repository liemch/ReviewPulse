import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";

import { DiffViewer } from "@/app/merge-requests/_components/diff-viewer";
import { AppShell } from "@/components/layout/app-shell";
import { IconGitBranch, IconLink } from "@/components/icons";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHead } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field, TextArea } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { requireUser } from "@/server/http";
import { getServices } from "@/server/services";

export const runtime = "nodejs";

function flashMessage(code: string | undefined): string | null {
  switch (code) {
    case "comment_ok":
      return "Đã gửi comment lên GitLab.";
    case "approve_ok":
      return "Đã phê duyệt Merge Request.";
    case "merge_ok":
      return "Đã merge Merge Request.";
    case "stale_sha":
      return "Merge Request đã thay đổi kể từ khi bạn mở trang. Vui lòng tải lại trước khi tiếp tục.";
    case "merge_blocked":
      return "Không thể merge: điều kiện an toàn chưa đủ (conflict / pipeline / approvals / draft / quyền).";
    case "not_confirmed":
      return "Hành động đã bị hủy — không gọi GitLab.";
    case "forbidden":
      return "GitLab từ chối quyền thực hiện hành động này.";
    case "unauthorized_credential":
      return "Credential GitLab của bạn không hợp lệ. Session ReviewPulse vẫn còn; hãy cập nhật PAT.";
    case "conflict":
      return "GitLab báo xung đột (409). Không merge.";
    case "invalid_input":
      return "Nội dung không hợp lệ.";
    case "fail":
      return "Thao tác thất bại. Không giả định đã thành công.";
    default:
      return null;
  }
}

export default async function MergeRequestDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{
    instanceId: string;
    projectId: string;
    iid: string;
  }>;
  searchParams?: Promise<{ flash?: string }>;
}) {
  const services = getServices();
  const jar = await cookies();
  const csrf = jar.get(services.policy.csrfCookieName)?.value;
  const routeParams = await params;
  const detailPath = `/merge-requests/${routeParams.instanceId}/${routeParams.projectId}/${routeParams.iid}`;
  if (!csrf) {
    redirect(`/api/auth/csrf?next=${encodeURIComponent(detailPath)}`);
  }

  const { user } = await requireUser();
  const iid = Number.parseInt(routeParams.iid, 10);
  if (!Number.isFinite(iid) || iid <= 0) {
    notFound();
  }

  const detail = await services.mrWorkspace.getDetail(user.id, {
    gitlabInstanceId: routeParams.instanceId,
    gitlabProjectId: routeParams.projectId,
    iid,
  });

  if ("kind" in detail) {
    redirect("/merge-requests?error=not_found");
  }

  const query = searchParams ? await searchParams : {};
  const flash = flashMessage(query.flash);
  const reviewedHeadSha = detail.reviewedHeadSha ?? "";
  const pipeline = detail.pipelines[0] ?? null;
  const canMutate = detail.mr.state === "opened";

  const diffFiles = detail.diffs.map((d) => ({
    path: d.newPath ?? d.oldPath ?? "(unknown)",
    oldPath: d.oldPath,
    newPath: d.newPath,
    newFile: d.newFile,
    deletedFile: d.deletedFile,
    renamedFile: d.renamedFile,
    diff: d.diff,
  }));

  const commonFields = {
    csrf,
    gitlabInstanceId: detail.gitlabInstanceId,
    gitlabProjectId: detail.gitlabProjectId,
    iid: String(detail.mr.iid),
    reviewedHeadSha,
    confirmed: "1",
  };

  return (
    <AppShell active="merge-requests" csrf={csrf}>
      <PageHeader
        title={`!${detail.mr.iid} ${detail.mr.title || ""}`}
        description={`${detail.pathWithNamespace ?? detail.gitlabProjectId} · live từ GitLab`}
        icon={<IconGitBranch size={22} />}
        actions={
          <ButtonLink href="/merge-requests" variant="ghost" size="sm">
            ← Danh sách
          </ButtonLink>
        }
      />

      {flash ? (
        <Alert
          tone={
            query.flash?.endsWith("_ok")
              ? "success"
              : query.flash === "stale_sha" || query.flash === "merge_blocked"
                ? "warning"
                : "danger"
          }
        >
          {flash}
        </Alert>
      ) : null}

      <Card>
        <CardHead
          title="Metadata"
          actions={
            detail.mr.webUrl ? (
              <a
                href={detail.mr.webUrl}
                target="_blank"
                rel="noreferrer"
                className="rp-link"
              >
                <IconLink size={14} /> Mở trên GitLab
              </a>
            ) : null
          }
        />
        <CardBody>
          <dl className="rp-meta-grid">
            <div>
              <dt>Trạng thái</dt>
              <dd>
                <Badge tone={detail.mr.state === "opened" ? "warning" : "neutral"}>
                  {detail.mr.state}
                  {detail.mr.draft ? " · draft" : ""}
                </Badge>
              </dd>
            </div>
            <div>
              <dt>Source → Target</dt>
              <dd>
                <code>
                  {detail.mr.sourceBranch} → {detail.mr.targetBranch}
                </code>
              </dd>
            </div>
            <div>
              <dt>Head SHA</dt>
              <dd>
                <code>{detail.mr.sha ?? "—"}</code>
              </dd>
            </div>
            <div>
              <dt>Tác giả</dt>
              <dd>{detail.mr.authorUsername ?? "—"}</dd>
            </div>
            <div>
              <dt>Reviewer</dt>
              <dd>
                {detail.mr.reviewers.length > 0
                  ? detail.mr.reviewers.join(", ")
                  : "—"}
              </dd>
            </div>
            <div>
              <dt>Conflicts</dt>
              <dd>{detail.mr.hasConflicts ? "Có xung đột" : "Không"}</dd>
            </div>
            <div>
              <dt>Merge status</dt>
              <dd>
                {detail.mr.detailedMergeStatus ??
                  detail.mr.mergeStatus ??
                  (detail.mr.mergeable === null
                    ? "—"
                    : detail.mr.mergeable
                      ? "mergeable"
                      : "not mergeable")}
              </dd>
            </div>
            <div>
              <dt>Quyền merge (GitLab)</dt>
              <dd>
                {detail.mr.userCanMerge === null
                  ? "không rõ"
                  : detail.mr.userCanMerge
                    ? "có"
                    : "không"}
              </dd>
            </div>
          </dl>
        </CardBody>
      </Card>

      <div className="rp-split-2">
        <Card>
          <CardHead title="Pipeline" />
          <CardBody>
            {pipeline ? (
              <ul className="rp-plain-list">
                <li>
                  Status: <strong>{pipeline.status}</strong>
                </li>
                <li>
                  SHA: <code>{pipeline.sha ?? "—"}</code>
                </li>
                {pipeline.webUrl ? (
                  <li>
                    <a
                      href={pipeline.webUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="rp-link"
                    >
                      Xem pipeline
                    </a>
                  </li>
                ) : null}
              </ul>
            ) : (
              <p className="rp-muted">Không có pipeline gần đây.</p>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHead title="Approvals" />
          <CardBody>
            {detail.approvals ? (
              <ul className="rp-plain-list">
                <li>
                  Approved:{" "}
                  <strong>{detail.approvals.approved ? "yes" : "no"}</strong>
                </li>
                <li>
                  Required: {detail.approvals.approvalsRequired ?? "—"} · Left:{" "}
                  {detail.approvals.approvalsLeft ?? "—"}
                </li>
                <li>
                  Approved by:{" "}
                  {detail.approvals.approvedBy.length > 0
                    ? detail.approvals.approvedBy.join(", ")
                    : "—"}
                </li>
                <li>
                  Bạn đã duyệt:{" "}
                  {detail.approvals.userHasApproved ? "có" : "chưa"} · Có thể
                  duyệt: {detail.approvals.userCanApprove ? "có" : "không"}
                </li>
              </ul>
            ) : (
              <p className="rp-muted">
                Không lấy được approvals (có thể instance không bật approval
                rules).
              </p>
            )}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHead
          title="Diff"
          description={`${diffFiles.length} file · không lưu full diff vào audit`}
        />
        <CardBody>
          <DiffViewer files={diffFiles} />
        </CardBody>
      </Card>

      {canMutate ? (
        <Card>
          <CardHead title="Hành động" />
          <CardBody>
            <form
              method="post"
              action="/api/merge-requests/comment"
              className="rp-stack"
            >
              <input type="hidden" name="csrf" value={csrf} />
              <input
                type="hidden"
                name="gitlabInstanceId"
                value={detail.gitlabInstanceId}
              />
              <input
                type="hidden"
                name="gitlabProjectId"
                value={detail.gitlabProjectId}
              />
              <input type="hidden" name="iid" value={String(detail.mr.iid)} />
              <Field id="body" label="Comment" required>
                <TextArea
                  id="body"
                  name="body"
                  rows={4}
                  placeholder="Viết comment…"
                  required
                />
              </Field>
              <Button type="submit" variant="primary">
                Gửi comment
              </Button>
            </form>

            <div className="rp-inline-actions">
              <ConfirmDialog
                action="/api/merge-requests/approve"
                fields={commonFields}
                triggerLabel="Phê duyệt"
                triggerVariant="primary"
                confirmVariant="primary"
                title={`Xác nhận phê duyệt Merge Request !${detail.mr.iid}?`}
                description="Hành động sẽ gọi GitLab bằng credential của bạn. Hủy sẽ không gọi GitLab."
                confirmLabel="Phê duyệt"
              />
              <ConfirmDialog
                action="/api/merge-requests/merge"
                fields={commonFields}
                triggerLabel="Merge"
                title="Xác nhận merge Merge Request này?"
                description={`!${detail.mr.iid} — ${detail.mr.title}. ${detail.mr.sourceBranch} → ${detail.mr.targetBranch}. Xác nhận merge Merge Request này? Hủy sẽ không gọi GitLab.`}
                confirmLabel="Merge"
              />
            </div>
          </CardBody>
        </Card>
      ) : null}
    </AppShell>
  );
}
