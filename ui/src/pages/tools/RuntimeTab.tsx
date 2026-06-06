import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2, RotateCw, Server, Square } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { queryKeys } from "@/lib/queryKeys";
import { toolsApi } from "@/api/tools";
import { ApiError } from "@/api/client";
import { useToast } from "@/context/ToastContext";
import { EmptyState } from "@/components/EmptyState";
import { ToolsPageHeader, LoadingState, ErrorState, HealthBadge, RelativeTime } from "./shared";

export function RuntimeTab({ companyId }: { companyId: string }) {
  const qc = useQueryClient();
  const { pushToast } = useToast();
  const slots = useQuery({
    queryKey: queryKeys.tools.runtimeSlots(companyId),
    queryFn: () => toolsApi.listRuntimeSlots(companyId),
    refetchInterval: 15_000,
  });
  const health = useQuery({
    queryKey: queryKeys.tools.runtimeHealth(companyId),
    queryFn: () => toolsApi.getRuntimeHealth(companyId),
    refetchInterval: 15_000,
  });

  const invalidateRuntime = () => {
    qc.invalidateQueries({ queryKey: queryKeys.tools.runtimeSlots(companyId) });
    qc.invalidateQueries({ queryKey: queryKeys.tools.runtimeHealth(companyId) });
  };

  const stopSlot = useMutation({
    mutationFn: (slotId: string) => toolsApi.stopRuntimeSlot(companyId, slotId),
    onSuccess: (slot) => {
      invalidateRuntime();
      pushToast({
        title: "Runtime slot stopped",
        body: slot.commandTemplateKey ?? slot.providerRef ?? slot.id,
        tone: "success",
      });
    },
    onError: (err) =>
      pushToast({
        title: "Stop failed",
        body: err instanceof ApiError ? err.message : String(err),
        tone: "error",
      }),
  });

  const restartSlot = useMutation({
    mutationFn: (slotId: string) => toolsApi.restartRuntimeSlot(companyId, slotId),
    onSuccess: (slot) => {
      invalidateRuntime();
      pushToast({
        title: "Runtime slot restarted",
        body: slot.commandTemplateKey ?? slot.providerRef ?? slot.id,
        tone: "success",
      });
    },
    onError: (err) =>
      pushToast({
        title: "Restart failed",
        body: err instanceof ApiError ? err.message : String(err),
        tone: "error",
      }),
  });

  if (slots.isLoading || health.isLoading) return <LoadingState />;
  if (slots.error || health.error) {
    return (
      <ErrorState
        error={slots.error ?? health.error}
        onRetry={() => {
          slots.refetch();
          health.refetch();
        }}
      />
    );
  }

  const list = slots.data?.runtimeSlots ?? [];
  const firingAlerts = health.data?.alerts ?? [];

  return (
    <div className="space-y-4">
      <ToolsPageHeader
        title="Runtime slots"
        description="Managed lifecycle units for local stdio MCP servers and remote sessions. Slots are pooled and supervised — agents never spawn processes directly. Idle local slots shut down automatically."
      />

      <Card className={health.data?.status === "critical" ? "border-destructive/40" : undefined}>
        <CardContent className="space-y-3 py-4">
          <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            Alert recommendations
            <HealthBadge
              status={health.data?.status === "critical" ? "error" : health.data?.status === "degraded" ? "degraded" : "ok"}
              label={health.data?.status ?? "unknown"}
            />
            <span className="ml-auto text-xs text-muted-foreground">{health.data?.runbookPath}</span>
          </div>
          {firingAlerts.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No runtime alerts are firing. Recommended thresholds are still available in the runbook.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {firingAlerts.map((alert) => (
                <li key={alert.name} className="py-2 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-foreground">{alert.name}</span>
                    <Badge variant={alert.severity === "critical" ? "destructive" : "secondary"}>
                      {alert.severity}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{alert.observed}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{alert.firstResponderAction}</p>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {list.length === 0 ? (
        <EmptyState
          icon={Server}
          message="No runtime slots"
          description="Local stdio connections lazy-start a runtime slot when a policy-allowed run first needs them. Remote HTTP connections do not use a local process."
        />
      ) : (
        <div className="grid gap-3">
          {list.map((slot) => {
            const supportsControl = slot.runtimeKind === "local_stdio";
            const controlsPending = stopSlot.isPending || restartSlot.isPending;
            const stopPending = stopSlot.isPending && stopSlot.variables === slot.id;
            const restartPending = restartSlot.isPending && restartSlot.variables === slot.id;
            const stopDisabled = !supportsControl || controlsPending || slot.status === "stopped";
            const restartDisabled = !supportsControl || controlsPending;
            return (
              <Card key={slot.id}>
                <CardContent className="flex flex-wrap items-center gap-3 py-4">
                  <Server className="h-5 w-5 text-muted-foreground" />
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-sm text-foreground">
                        {slot.commandTemplateKey ?? slot.providerRef ?? slot.id.slice(0, 8)}
                      </span>
                      <Badge variant="outline">{slot.runtimeKind}</Badge>
                      <Badge variant="secondary">{slot.status}</Badge>
                      <HealthBadge status={slot.healthStatus} />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      scope {slot.ownerScopeType}
                      {slot.processId ? ` · pid ${slot.processId}` : ""} · last used{" "}
                      <RelativeTime value={slot.lastUsedAt} />
                      {slot.idleExpiresAt || slot.idleDeadlineAt ? (
                        <>
                          {" "}
                          · idles <RelativeTime value={slot.idleExpiresAt ?? slot.idleDeadlineAt} />
                        </>
                      ) : null}
                      {slot.lastError ? (
                        <span className="text-destructive"> · {slot.lastError}</span>
                      ) : null}
                    </p>
                  </div>
                  <div className="ml-auto flex shrink-0 gap-1.5">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={stopDisabled}
                            aria-label="Stop runtime slot"
                            onClick={() => stopSlot.mutate(slot.id)}
                          >
                            {stopPending ? (
                              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Square className="mr-1 h-3.5 w-3.5" fill="currentColor" />
                            )}
                            Stop
                          </Button>
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        {!supportsControl
                          ? "Remote sessions have no local process to stop."
                          : slot.status === "stopped"
                            ? "This runtime slot is already stopped."
                            : "Stop this local stdio runtime slot."}
                      </TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={restartDisabled}
                            aria-label="Restart runtime slot"
                            onClick={() => restartSlot.mutate(slot.id)}
                          >
                            {restartPending ? (
                              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <RotateCw className="mr-1 h-3.5 w-3.5" />
                            )}
                            Restart
                          </Button>
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        {supportsControl
                          ? "Restart this local stdio runtime slot."
                          : "Remote sessions have no local process to restart."}
                      </TooltipContent>
                    </Tooltip>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Health and lifecycle shown here reflect server state. Stop and restart controls apply only to local
        stdio runtime slots.
      </p>
    </div>
  );
}
