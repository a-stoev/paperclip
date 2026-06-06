import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, CircleSlash, PackagePlus, PlayCircle, Sparkles, XCircle } from "lucide-react";
import type { ToolExampleSmokeResult } from "@paperclipai/shared";
import { queryKeys } from "@/lib/queryKeys";
import { toolsApi } from "@/api/tools";
import { ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/context/ToastContext";
import { EmptyState } from "@/components/EmptyState";
import {
  CapabilityBadges,
  DecisionBadge,
  ErrorState,
  LoadingState,
  RiskBadge,
  ToolsPageHeader,
} from "./shared";

function errorMessage(error: unknown) {
  return error instanceof ApiError ? error.message : error instanceof Error ? error.message : String(error);
}

function SmokeResult({ result }: { result: ToolExampleSmokeResult }) {
  return (
    <div className="rounded-md border border-border bg-muted/30 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
        {result.ok ? (
          <CheckCircle2 className="h-4 w-4 text-emerald-600" />
        ) : (
          <XCircle className="h-4 w-4 text-destructive" />
        )}
        <span className="font-medium text-foreground">
          Smoke {result.ok ? "passed" : "failed"}
        </span>
        <Badge variant="outline">{result.actor.actorType}</Badge>
      </div>
      <div className="grid gap-2">
        {result.checks.map((check) => (
          <div key={check.name} className="flex flex-wrap items-center gap-2 text-sm">
            {check.ok ? (
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
            ) : (
              <XCircle className="h-3.5 w-3.5 text-destructive" />
            )}
            <span className="font-medium text-foreground">{check.name.replaceAll("_", " ")}</span>
            {check.toolName ? <span className="font-mono text-xs text-muted-foreground">{check.toolName}</span> : null}
            {check.decision ? <DecisionBadge decision={check.decision} /> : null}
            {check.reasonCode ? <span className="font-mono text-xs text-muted-foreground">{check.reasonCode}</span> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

export function ExamplesTab({ companyId }: { companyId: string }) {
  const qc = useQueryClient();
  const { pushToast } = useToast();
  const [smokeResults, setSmokeResults] = useState<Record<string, ToolExampleSmokeResult>>({});

  const examples = useQuery({
    queryKey: queryKeys.tools.examples(companyId),
    queryFn: () => toolsApi.listExamples(companyId),
  });

  const invalidateToolState = () => {
    qc.invalidateQueries({ queryKey: queryKeys.tools.examples(companyId) });
    qc.invalidateQueries({ queryKey: queryKeys.tools.applications(companyId) });
    qc.invalidateQueries({ queryKey: queryKeys.tools.connections(companyId) });
    qc.invalidateQueries({ queryKey: queryKeys.tools.runtimeSlots(companyId) });
    qc.invalidateQueries({ queryKey: queryKeys.tools.runtimeHealth(companyId) });
    qc.invalidateQueries({ queryKey: queryKeys.tools.audit(companyId, 100) });
  };

  const install = useMutation({
    mutationFn: (exampleId: string) => toolsApi.installExample(companyId, exampleId),
    onSuccess: (result) => {
      invalidateToolState();
      pushToast({
        title: result.created ? "Example installed" : "Example already installed",
        body: `${result.profileEntries.length} read-only tool grant(s) active`,
        tone: "success",
      });
    },
    onError: (error) =>
      pushToast({
        title: "Install failed",
        body: errorMessage(error),
        tone: "error",
      }),
  });

  const smoke = useMutation({
    mutationFn: (exampleId: string) => toolsApi.smokeExample(companyId, exampleId),
    onSuccess: (result) => {
      setSmokeResults((current) => ({ ...current, [result.exampleId]: result }));
      invalidateToolState();
      pushToast({
        title: result.ok ? "Smoke passed" : "Smoke failed",
        body: `${result.checks.filter((check) => check.ok).length}/${result.checks.length} checks passed`,
        tone: result.ok ? "success" : "error",
      });
    },
    onError: (error) =>
      pushToast({
        title: "Smoke failed",
        body: errorMessage(error),
        tone: "error",
      }),
  });

  if (examples.isLoading) return <LoadingState />;
  if (examples.error) return <ErrorState error={examples.error} onRetry={() => examples.refetch()} />;

  const list = examples.data?.examples ?? [];

  return (
    <div className="space-y-4">
      <ToolsPageHeader
        title="Examples & smoke tests"
        description="Install safe fixture connections and run server-side governance checks for allow, deny, and audit paths."
      />

      {list.length === 0 ? (
        <EmptyState
          icon={Sparkles}
          message="No examples available"
          description="Example fixtures are bundled with Paperclip and should appear here when the server exposes them."
        />
      ) : (
        <div className="grid gap-3">
          {list.map((example) => {
            const installed = example.install.installed;
            const result = smokeResults[example.id];
            return (
              <Card key={example.id}>
                <CardContent className="space-y-4 py-4">
                  <div className="flex flex-wrap items-start gap-3">
                    <Sparkles className="mt-0.5 h-5 w-5 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-foreground">{example.title}</span>
                        <Badge variant={installed ? "default" : "outline"}>
                          {installed ? "installed" : "available"}
                        </Badge>
                        <Badge variant="outline">{example.fixture.transport}</Badge>
                      </div>
                      <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{example.description}</p>
                    </div>
                    <div className="flex shrink-0 gap-1.5">
                      <Button
                        size="sm"
                        variant={installed ? "outline" : "default"}
                        disabled={!example.install.canInstall || install.isPending}
                        onClick={() => install.mutate(example.id)}
                      >
                        <PackagePlus className="mr-1 h-3.5 w-3.5" />
                        {installed ? "Repair" : "Install"}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!installed || smoke.isPending}
                        onClick={() => smoke.mutate(example.id)}
                      >
                        <PlayCircle className="mr-1 h-3.5 w-3.5" />
                        Smoke
                      </Button>
                    </div>
                  </div>

                  {example.install.reason ? (
                    <div className="flex items-start gap-2 rounded-md border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
                      <CircleSlash className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>{example.install.reason}</span>
                    </div>
                  ) : null}

                  <div className="grid gap-3 lg:grid-cols-[1.2fr_0.8fr]">
                    <div className="space-y-2">
                      <p className="text-xs font-medium uppercase tracking-normal text-muted-foreground">Fixture tools</p>
                      <div className="flex flex-wrap gap-2">
                        {example.fixture.tools.map((tool) => (
                          <span key={tool.name} className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs">
                            <span className="font-mono text-foreground">{tool.name}</span>
                            <RiskBadge risk={tool.riskLevel} />
                            <CapabilityBadges isReadOnly={tool.readOnly} isWrite={tool.riskLevel === "write"} isDestructive={tool.riskLevel === "destructive"} />
                          </span>
                        ))}
                      </div>
                    </div>
                    <div className="space-y-2">
                      <p className="text-xs font-medium uppercase tracking-normal text-muted-foreground">Safe default profile</p>
                      <div className="rounded-md border border-border p-3 text-sm">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-foreground">{example.safeDefaultProfile.name}</span>
                          <DecisionBadge decision={example.safeDefaultProfile.defaultAction} />
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Allows {example.safeDefaultProfile.allowedToolNames.join(", ")}
                        </p>
                      </div>
                    </div>
                  </div>

                  {result ? <SmokeResult result={result} /> : null}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
