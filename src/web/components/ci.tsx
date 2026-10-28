import { CircleCheck, CircleDashed, CircleMinus, CircleSlash, CircleX, Hourglass, LoaderCircle } from "lucide-react";

export type CiStatus = "queued" | "waiting" | "running" | "success" | "failure" | "cancelled" | "error" | "skipped";

const LABEL: Record<CiStatus, string> = { queued: "Queued", waiting: "Waiting", running: "Running", success: "Passed", failure: "Failed", cancelled: "Cancelled", error: "Error", skipped: "Skipped" };

export function CiBadge({ status }: { status: CiStatus }) {
  const Icon = { queued: CircleDashed, waiting: Hourglass, running: LoaderCircle, success: CircleCheck, failure: CircleX, cancelled: CircleSlash, error: CircleX, skipped: CircleMinus }[status];
  return (
    <span className={`ci-badge ci-${status}`}>
      <Icon size={14} aria-hidden className={status === "running" ? "spin" : ""} /> {LABEL[status]}
    </span>
  );
}

// Waiting runs (a deployment waits for a reviewer or a timer) aren't done, but may stay that way for a long time.
export const ciDone = (s: CiStatus) => s !== "queued" && s !== "running" && s !== "waiting";
