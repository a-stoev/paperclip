import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ScrollText } from "lucide-react";
import { Link } from "@/lib/router";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { queryKeys } from "@/lib/queryKeys";
import { toolsApi, type ToolGatewayAuditRow } from "@/api/tools";
import { EmptyState } from "@/components/EmptyState";
import { ToolsPageHeader, LoadingState, ErrorState, RelativeTime } from "./shared";

const OUTCOME_FILTERS = [
  { value: "__all", label: "All outcomes" },
  { value: "allowed", label: "Allowed", match: ["call_allowed", "call_completed"] },
  { value: "denied", label: "Denied", match: ["call_denied"] },
  { value: "failed", label: "Failed", match: ["call_failed"] },
  { value: "approval", label: "Approval requested", match: ["approval_requested"] },
  { value: "deferred", label: "Deferred", match: ["call_deferred"] },
] as const;

function detailString(details: Record<string, unknown> | null, key: string): string | undefined {
  const v = details?.[key];
  return typeof v === "string" ? v : undefined;
}

function actionBadge(action: string) {
  if (action.endsWith("denied")) return <Badge variant="destructive">denied</Badge>;
  if (action.endsWith("failed")) return <Badge variant="destructive">failed</Badge>;
  if (action.endsWith("deferred")) return <Badge variant="secondary">deferred</Badge>;
  if (action.includes("approval")) return <Badge variant="secondary">approval</Badge>;
  if (action.endsWith("allowed") || action.endsWith("completed")) return <Badge>allowed</Badge>;
  return <Badge variant="outline">{action.replace("tool_gateway.", "")}</Badge>;
}

function AuditRow({ row }: { row: ToolGatewayAuditRow }) {
  const tool = detailString(row.details, "tool") ?? detailString(row.details, "toolName") ?? "—";
  const reason = detailString(row.details, "reasonCode");
  const issueId = detailString(row.details, "issueId");
  const runId = detailString(row.details, "runId");
  const agentId = detailString(row.details, "agentId") ?? row.actorId ?? undefined;
  return (
    <li className="flex flex-wrap items-center gap-2 py-2.5 text-sm">
      {actionBadge(row.action)}
      <span className="font-mono text-xs text-foreground">{tool}</span>
      {reason ? <span className="text-xs text-muted-foreground">{reason}</span> : null}
      <span className="ml-auto flex shrink-0 items-center gap-2 text-xs">
        {issueId ? (
          <Link to={`/issues/${issueId}`} className="text-primary hover:underline">
            issue
          </Link>
        ) : null}
        {runId && agentId ? (
          <Link to={`/agents/${agentId}/runs/${runId}`} className="text-primary hover:underline">
            run
          </Link>
        ) : null}
        <RelativeTime value={row.createdAt} />
      </span>
    </li>
  );
}

export function AuditTab({ companyId }: { companyId: string }) {
  const [limit, setLimit] = useState(100);
  const [outcome, setOutcome] = useState<string>("__all");
  const [query, setQuery] = useState("");

  const audit = useQuery({
    queryKey: queryKeys.tools.audit(companyId, limit),
    queryFn: () => toolsApi.listAudit(companyId, limit),
  });

  const filtered = useMemo(() => {
    let rows = audit.data ?? [];
    const f = OUTCOME_FILTERS.find((o) => o.value === outcome);
    if (f && "match" in f) {
      rows = rows.filter((r) => f.match.some((m) => r.action.includes(m)));
    }
    const q = query.trim().toLowerCase();
    if (q) {
      rows = rows.filter((r) => JSON.stringify(r.details ?? {}).toLowerCase().includes(q) || r.action.includes(q));
    }
    return rows;
  }, [audit.data, outcome, query]);

  return (
    <div className="space-y-4">
      <ToolsPageHeader
        title="Audit"
        description="Every governed tool-call decision — allow, deny, approval, defer, failure — with run and issue links. Values are redacted; audit never stores secrets or raw arguments."
      />

      <div className="flex flex-wrap items-center gap-2">
        <Select value={outcome} onValueChange={setOutcome}>
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {OUTCOME_FILTERS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          placeholder="Filter by tool, reason, agent…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="max-w-xs"
        />
        <Select value={String(limit)} onValueChange={(v) => setLimit(Number(v))}>
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[50, 100, 250, 500].map((n) => (
              <SelectItem key={n} value={String(n)}>
                Last {n}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {audit.isLoading ? (
        <LoadingState />
      ) : audit.error ? (
        <ErrorState error={audit.error} onRetry={() => audit.refetch()} />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={ScrollText}
          message="No matching audit events"
          description="Governed tool calls appear here as soon as agents start using the gateway."
        />
      ) : (
        <Card>
          <CardContent className="py-2">
            <ul className="divide-y divide-border">
              {filtered.map((row) => (
                <AuditRow key={row.id} row={row} />
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
