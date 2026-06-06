import { useQuery } from "@tanstack/react-query";
import { cva, type VariantProps } from "class-variance-authority";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";
import { queryKeys } from "@/lib/queryKeys";
import { toolsApi } from "@/api/tools";

/**
 * Persistent enforcement-state banner for the Tools & Access surface (PAP-10389).
 *
 * Always rendered so users never mistake the absence of a warning for the
 * absence of enforcement. The `denied-detected` variant tints when governed
 * tool calls were denied or failed in the last hour. This is an *observability*
 * banner — enforcement itself lives in the tool gateway, not here.
 */
const enforcementBanner = cva(
  "flex items-start gap-2.5 rounded-lg border px-4 py-3 text-sm",
  {
    variants: {
      variant: {
        default: "border-border bg-muted/40 text-muted-foreground",
        "denied-detected":
          "border-amber-500/40 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

const DENY_ACTIONS = new Set(["tool_gateway.call_denied", "tool_gateway.call_failed"]);
const ONE_HOUR_MS = 60 * 60 * 1000;

export interface EnforcementBannerProps extends VariantProps<typeof enforcementBanner> {
  companyId: string;
  className?: string;
  /** Override the computed variant (used by the design guide). */
  forceVariant?: "default" | "denied-detected";
  recentDenialCount?: number;
}

export function EnforcementBanner({ companyId, className, forceVariant, recentDenialCount }: EnforcementBannerProps) {
  const audit = useQuery({
    queryKey: queryKeys.tools.audit(companyId, 100),
    queryFn: () => toolsApi.listAudit(companyId, 100),
    enabled: forceVariant === undefined && recentDenialCount === undefined && !!companyId,
    refetchInterval: 30_000,
  });

  const computedCount =
    recentDenialCount ??
    (audit.data ?? []).filter((row) => {
      if (!DENY_ACTIONS.has(row.action)) return false;
      const ts = new Date(row.createdAt).getTime();
      return Number.isFinite(ts) && Date.now() - ts <= ONE_HOUR_MS;
    }).length;

  const variant: "default" | "denied-detected" =
    forceVariant ?? (computedCount > 0 ? "denied-detected" : "default");

  return (
    <div className={cn(enforcementBanner({ variant }), className)} role="status">
      {variant === "denied-detected" ? (
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
      ) : (
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
      )}
      <div className="min-w-0 flex-1">
        {variant === "denied-detected" ? (
          <p>
            <span className="font-medium">{computedCount}</span> governed tool call
            {computedCount === 1 ? " was" : "s were"} denied or failed in the last hour. Access is enforced
            server-side by the tool gateway — review what was blocked and why in the audit log.
          </p>
        ) : (
          <p>
            Tool access is enforced server-side by the tool gateway. These screens configure and observe that
            enforcement — they do not replace it. Agents see and call only the tools their profiles and policies
            allow; everything else is denied by default.
          </p>
        )}
      </div>
      <Link
        to="/company/settings/tools/audit"
        className="shrink-0 text-xs font-medium text-primary hover:underline"
      >
        View audit →
      </Link>
    </div>
  );
}
