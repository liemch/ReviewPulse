"use client";

import { useState } from "react";

export type DiffFileView = {
  path: string;
  oldPath: string | null;
  newPath: string | null;
  newFile: boolean;
  deletedFile: boolean;
  renamedFile: boolean;
  diff: string;
};

function countChanges(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      additions += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      deletions += 1;
    }
  }
  return { additions, deletions };
}

export function DiffViewer({ files }: { files: readonly DiffFileView[] }) {
  const [open, setOpen] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    for (const file of files.slice(0, 5)) {
      initial[file.path] = true;
    }
    return initial;
  });

  if (files.length === 0) {
    return (
      <p className="rp-muted">Không có diff hoặc GitLab không trả về diff.</p>
    );
  }

  return (
    <div className="rp-diff-list">
      {files.map((file) => {
        const expanded = open[file.path] === true;
        const { additions, deletions } = countChanges(file.diff);
        return (
          <section key={file.path} className="rp-diff-file">
            <button
              type="button"
              className="rp-diff-file-head"
              aria-expanded={expanded}
              onClick={() =>
                setOpen((prev) => ({ ...prev, [file.path]: !expanded }))
              }
            >
              <span className="rp-diff-path">{file.path}</span>
              <span className="rp-diff-stats">
                {file.newFile ? <span className="rp-diff-tag">new</span> : null}
                {file.deletedFile ? (
                  <span className="rp-diff-tag">deleted</span>
                ) : null}
                {file.renamedFile ? (
                  <span className="rp-diff-tag">renamed</span>
                ) : null}
                <span className="rp-diff-add">+{additions}</span>
                <span className="rp-diff-del">−{deletions}</span>
              </span>
            </button>
            {expanded ? (
              <pre className="rp-diff-body" tabIndex={0}>
                {file.diff.split("\n").map((line, index) => {
                  let cls = "rp-diff-line";
                  if (line.startsWith("@@")) cls += " rp-diff-hunk";
                  else if (line.startsWith("+") && !line.startsWith("+++")) {
                    cls += " rp-diff-plus";
                  } else if (line.startsWith("-") && !line.startsWith("---")) {
                    cls += " rp-diff-minus";
                  } else if (
                    line.startsWith("+++") ||
                    line.startsWith("---")
                  ) {
                    cls += " rp-diff-meta";
                  }
                  return (
                    <div key={`${file.path}:${index}`} className={cls}>
                      <span className="rp-diff-ln">{index + 1}</span>
                      <span className="rp-diff-text">{line.length === 0 ? " " : line}</span>
                    </div>
                  );
                })}
              </pre>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
