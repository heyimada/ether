import { CircleCheck, CircleDashed, CircleSlash, CircleX, LoaderCircle } from "lucide-react";

export type CiStatus = "queued" | "running" | "success" | "failure" | "cancelled" | "error";

const LABEL: Record<CiStatus, string> = { queued: "Queued", running: "Running", success: "Passed", failure: "Failed", cancelled: "Cancelled", error: "Error" };

export function CiBadge({ status }: { status: CiStatus }) {
  const Icon = { queued: CircleDashed, running: LoaderCircle, success: CircleCheck, failure: CircleX, cancelled: CircleSlash, error: CircleX }[status];
  return (
    <span className={`ci-badge ci-${status}`}>
      <Icon size={14} aria-hidden className={status === "running" ? "spin" : ""} /> {LABEL[status]}
    </span>
  );
}

export const ciDone = (s: CiStatus) => s !== "queued" && s !== "running";
