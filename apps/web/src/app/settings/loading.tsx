import { Skeleton, SkeletonCard } from "@/components/ui/skeleton";

export default function SettingsLoading() {
  return (
    <div className="rp-main">
      <div className="rp-main-inner">
        <div>
          <Skeleton width={220} height={30} />
          <div style={{ marginTop: 10 }}>
            <Skeleton width={380} height={14} />
          </div>
        </div>
        <SkeletonCard rows={4} />
        <SkeletonCard rows={2} />
      </div>
    </div>
  );
}
