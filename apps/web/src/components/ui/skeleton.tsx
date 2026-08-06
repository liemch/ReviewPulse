export function Skeleton({
  width = "100%",
  height = 16,
}: {
  width?: number | string;
  height?: number | string;
}) {
  return <div className="rp-skeleton" style={{ width, height }} />;
}

export function SkeletonCard({ rows = 3 }: { rows?: number }) {
  return (
    <div className="rp-card">
      <div className="rp-card-body">
        <Skeleton width={180} height={20} />
        {Array.from({ length: rows }, (_, index) => (
          <Skeleton key={index} height={14} />
        ))}
      </div>
    </div>
  );
}
