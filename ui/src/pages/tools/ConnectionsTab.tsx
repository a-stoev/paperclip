import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, ListTree, Plug, Plus, RefreshCw, Stethoscope, Trash2 } from "lucide-react";
import type { McpConnectionCredentialRef, ToolConnection } from "@paperclipai/shared";
import { queryKeys } from "@/lib/queryKeys";
import { toolsApi, type CreateToolConnectionInput } from "@/api/tools";
import { secretsApi } from "@/api/secrets";
import { ApiError } from "@/api/client";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/context/ToastContext";
import {
  ToolsPageHeader,
  LoadingState,
  ErrorState,
  HealthBadge,
  RiskBadge,
  CapabilityBadges,
  QuarantineBadge,
  RelativeTime,
} from "./shared";

function CatalogDialog({ connection, onClose }: { connection: ToolConnection; onClose: () => void }) {
  const catalog = useQuery({
    queryKey: queryKeys.tools.catalog(connection.id),
    queryFn: () => toolsApi.listCatalog(connection.id),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Tool catalog — {connection.name}</DialogTitle>
        </DialogHeader>
        {catalog.isLoading ? (
          <LoadingState />
        ) : catalog.error ? (
          <ErrorState error={catalog.error} onRetry={() => catalog.refetch()} />
        ) : (catalog.data?.catalog ?? []).length === 0 ? (
          <p className="py-6 text-sm text-muted-foreground">
            No tools discovered yet. Use “Refresh catalog” to discover tools from this connection.
          </p>
        ) : (
          <ul className="max-h-[60vh] divide-y divide-border overflow-y-auto">
            {(catalog.data?.catalog ?? []).map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-center gap-2 py-2.5">
                <span className="font-mono text-sm text-foreground">{entry.toolName}</span>
                <RiskBadge risk={entry.riskLevel} />
                <CapabilityBadges
                  isReadOnly={entry.isReadOnly}
                  isWrite={entry.isWrite}
                  isDestructive={entry.isDestructive}
                />
                {entry.status === "quarantined" ? <QuarantineBadge /> : null}
                {entry.description ? (
                  <p className="w-full truncate text-xs text-muted-foreground">{entry.description}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

type CredentialDraft = { secretId: string; headerName: string };

/**
 * New-connection dialog. Enforces secret *references* (no free-text token field)
 * and runs a live gateway probe (health-check) against the draft before the
 * operator activates it — per the Phase 0B spec surface map.
 */
function NewConnectionDialog({ companyId, onClose }: { companyId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { pushToast } = useToast();

  const apps = useQuery({
    queryKey: queryKeys.tools.applications(companyId),
    queryFn: () => toolsApi.listApplications(companyId),
  });
  const secrets = useQuery({
    queryKey: queryKeys.secrets.list(companyId),
    queryFn: () => secretsApi.list(companyId),
  });
  const templates = useQuery({
    queryKey: queryKeys.tools.stdioTemplates(companyId),
    queryFn: () => toolsApi.listStdioTemplates(companyId),
  });

  const [applicationId, setApplicationId] = useState("");
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"remote_http" | "local_stdio">("remote_http");
  const [endpointUrl, setEndpointUrl] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [creds, setCreds] = useState<CredentialDraft[]>([]);
  const [pendingSecretId, setPendingSecretId] = useState("");
  const [pendingHeader, setPendingHeader] = useState("Authorization");
  const [draft, setDraft] = useState<ToolConnection | null>(null);

  const secretName = (id: string) => secrets.data?.find((s) => s.id === id)?.name ?? id.slice(0, 8);

  const credentialRefs: McpConnectionCredentialRef[] = useMemo(
    () =>
      creds.map((c) => ({
        name: c.headerName,
        secretId: c.secretId,
        version: "latest",
        placement: "header",
        key: c.headerName,
      })),
    [creds],
  );

  const create = useMutation({
    mutationFn: () => {
      const config: Record<string, unknown> =
        transport === "remote_http" ? { url: endpointUrl.trim() } : { templateId };
      const input: CreateToolConnectionInput = {
        applicationId,
        name: name.trim(),
        transport,
        status: "draft",
        enabled: false,
        config,
        credentialRefs,
      };
      return toolsApi.createConnection(companyId, input);
    },
    onSuccess: (conn) => setDraft(conn),
    onError: (err) =>
      pushToast({
        title: "Could not create connection",
        body: err instanceof ApiError ? err.message : String(err),
        tone: "error",
      }),
  });

  const probe = useMutation({
    mutationFn: (id: string) => toolsApi.checkConnectionHealth(id),
    onSuccess: (res) => setDraft(res.connection),
    onError: (err) =>
      pushToast({
        title: "Probe failed",
        body: err instanceof ApiError ? err.message : String(err),
        tone: "error",
      }),
  });

  const activate = useMutation({
    mutationFn: (id: string) => toolsApi.updateConnection(id, { status: "active", enabled: true }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.tools.connections(companyId) });
      pushToast({ title: "Connection activated", tone: "success" });
      onClose();
    },
    onError: (err) =>
      pushToast({
        title: "Activation failed",
        body: err instanceof ApiError ? err.message : String(err),
        tone: "error",
      }),
  });

  const addCred = () => {
    if (!pendingSecretId || !pendingHeader.trim()) return;
    setCreds((c) => [...c, { secretId: pendingSecretId, headerName: pendingHeader.trim() }]);
    setPendingSecretId("");
  };

  const transportConfigValid =
    transport === "remote_http" ? endpointUrl.trim().length > 0 : templateId.length > 0;
  const canCreate = !!applicationId && name.trim().length > 0 && transportConfigValid && !create.isPending;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New connection</DialogTitle>
          <DialogDescription>
            Credentials are stored as secret references — Paperclip resolves them at gateway use time and never
            exposes them to agents. The connection is created as a draft and probed before you activate it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Application</Label>
            <Select value={applicationId} onValueChange={setApplicationId} disabled={!!draft}>
              <SelectTrigger>
                <SelectValue placeholder="Select an application" />
              </SelectTrigger>
              <SelectContent>
                {(apps.data?.applications ?? []).map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="conn-name">Name</Label>
            <Input
              id="conn-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Production GitHub"
              disabled={!!draft}
            />
          </div>

          <div className="space-y-1.5">
            <Label>Transport</Label>
            <Select
              value={transport}
              onValueChange={(v) => setTransport(v as "remote_http" | "local_stdio")}
              disabled={!!draft}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="remote_http">Remote HTTP (no local process)</SelectItem>
                <SelectItem value="local_stdio">Local stdio (approved template)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {transport === "remote_http" ? (
            <div className="space-y-1.5">
              <Label htmlFor="conn-url">Endpoint URL</Label>
              <Input
                id="conn-url"
                value={endpointUrl}
                onChange={(e) => setEndpointUrl(e.target.value)}
                placeholder="https://mcp.example.com"
                disabled={!!draft}
              />
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label>Command template</Label>
              <Select value={templateId} onValueChange={setTemplateId} disabled={!!draft}>
                <SelectTrigger>
                  <SelectValue placeholder="Select an approved template" />
                </SelectTrigger>
                <SelectContent>
                  {(templates.data?.templates ?? []).map((t) => (
                    <SelectItem key={t.templateId} value={t.templateId}>
                      {t.title ?? t.templateId}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Only board-approved command templates can run. Arbitrary commands are never accepted.
              </p>
            </div>
          )}

          {/* Secret-reference picker — no free-text token field. */}
          <div className="space-y-1.5">
            <Label>Credential references</Label>
            {creds.length > 0 ? (
              <ul className="space-y-1">
                {creds.map((c, i) => (
                  <li key={`${c.secretId}-${i}`} className="flex items-center gap-2 text-sm">
                    <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="font-mono text-xs">{c.headerName}</span>
                    <span className="text-muted-foreground">→ secret {secretName(c.secretId)}</span>
                    {!draft ? (
                      <button
                        type="button"
                        className="ml-auto text-muted-foreground hover:text-destructive"
                        onClick={() => setCreds((cs) => cs.filter((_, idx) => idx !== i))}
                        aria-label="Remove credential reference"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {!draft ? (
              <div className="flex items-end gap-2">
                <div className="flex-1 space-y-1">
                  <Select value={pendingSecretId} onValueChange={setPendingSecretId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Secret" />
                    </SelectTrigger>
                    <SelectContent>
                      {(secrets.data ?? []).map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Input
                  value={pendingHeader}
                  onChange={(e) => setPendingHeader(e.target.value)}
                  placeholder="Header"
                  className="w-32"
                  aria-label="Header name"
                />
                <Button type="button" size="sm" variant="outline" onClick={addCred} disabled={!pendingSecretId}>
                  Add
                </Button>
              </div>
            ) : null}
          </div>

          {draft ? (
            <div className="rounded-md border border-border bg-muted/40 p-3 text-sm">
              <div className="flex items-center gap-2">
                <span className="font-medium text-foreground">Probe result</span>
                <HealthBadge status={draft.healthStatus} />
              </div>
              {draft.healthMessage ? (
                <p className="mt-1 text-xs text-muted-foreground">{draft.healthMessage}</p>
              ) : null}
              {draft.lastError ? <p className="mt-1 text-xs text-destructive">{draft.lastError}</p> : null}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          {!draft ? (
            <Button disabled={!canCreate} onClick={() => create.mutate()}>
              {create.isPending ? "Creating draft…" : "Create & probe"}
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                disabled={probe.isPending}
                onClick={() => probe.mutate(draft.id)}
              >
                <Stethoscope className="mr-1 h-3.5 w-3.5" />
                {probe.isPending ? "Probing…" : "Re-probe"}
              </Button>
              <Button disabled={activate.isPending} onClick={() => activate.mutate(draft.id)}>
                {activate.isPending ? "Activating…" : "Activate"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ConnectionsTab({ companyId }: { companyId: string }) {
  const qc = useQueryClient();
  const { pushToast } = useToast();
  const [catalogFor, setCatalogFor] = useState<ToolConnection | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const connections = useQuery({
    queryKey: queryKeys.tools.connections(companyId),
    queryFn: () => toolsApi.listConnections(companyId),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: queryKeys.tools.connections(companyId) });

  const healthCheck = useMutation({
    mutationFn: (id: string) => toolsApi.checkConnectionHealth(id),
    onSuccess: (res) => {
      invalidate();
      pushToast({
        title: `Health: ${res.connection.healthStatus}`,
        body: res.connection.healthMessage ?? undefined,
        tone: res.connection.healthStatus === "error" ? "error" : "success",
      });
    },
    onError: (err) =>
      pushToast({
        title: "Health check failed",
        body: err instanceof ApiError ? err.message : String(err),
        tone: "error",
      }),
  });

  const refresh = useMutation({
    mutationFn: (id: string) => toolsApi.refreshCatalog(id),
    onSuccess: (res) => {
      invalidate();
      qc.invalidateQueries({ queryKey: queryKeys.tools.catalog(res.connection.id) });
      pushToast({
        title: `Discovered ${res.discoveredCount} tools`,
        body: res.quarantinedCount > 0 ? `${res.quarantinedCount} quarantined for review` : undefined,
        tone: "success",
      });
    },
    onError: (err) =>
      pushToast({
        title: "Catalog refresh failed",
        body: err instanceof ApiError ? err.message : String(err),
        tone: "error",
      }),
  });

  if (connections.isLoading) return <LoadingState />;
  if (connections.error) return <ErrorState error={connections.error} onRetry={() => connections.refetch()} />;

  const list = (connections.data?.connections ?? []).filter((c) => (c.status ?? "active") !== "archived");

  return (
    <div className="space-y-4">
      <ToolsPageHeader
        title="Connections"
        description="Managed credentials and transport for each application. Credentials are stored as secret references and only resolve at gateway/runtime use time — never sent to agents."
        actions={
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="mr-1 h-4 w-4" />
            New connection
          </Button>
        }
      />

      {list.length === 0 ? (
        <EmptyState
          icon={Plug}
          message="No connections yet"
          description="Add a connection to an application to configure credentials and discover its tools."
          action="New connection"
          onAction={() => setCreateOpen(true)}
        />
      ) : (
        <div className="grid gap-3">
          {list.map((conn) => (
            <Card key={conn.id}>
              <CardContent className="flex flex-wrap items-center gap-3 py-4">
                <Plug className="h-5 w-5 text-muted-foreground" />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-foreground">{conn.name}</span>
                    <Badge variant="outline">{conn.transport ?? "—"}</Badge>
                    <HealthBadge status={conn.healthStatus} />
                    {!conn.enabled ? <Badge variant="outline">disabled</Badge> : null}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {(conn.credentialRefs?.length ?? 0) + conn.credentialSecretRefs.length} credential
                    ref(s) · last refresh{" "}
                    <RelativeTime value={conn.lastCatalogRefreshAt ?? conn.updatedAt} />
                    {conn.lastError ? <span className="text-destructive"> · {conn.lastError}</span> : null}
                  </p>
                </div>
                <div className="ml-auto flex shrink-0 gap-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={healthCheck.isPending}
                    onClick={() => healthCheck.mutate(conn.id)}
                  >
                    <Stethoscope className="mr-1 h-3.5 w-3.5" />
                    Test
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={refresh.isPending}
                    onClick={() => refresh.mutate(conn.id)}
                  >
                    <RefreshCw className="mr-1 h-3.5 w-3.5" />
                    Refresh
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setCatalogFor(conn)}>
                    <ListTree className="mr-1 h-3.5 w-3.5" />
                    Tools
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {catalogFor ? <CatalogDialog connection={catalogFor} onClose={() => setCatalogFor(null)} /> : null}
      {createOpen ? <NewConnectionDialog companyId={companyId} onClose={() => setCreateOpen(false)} /> : null}
    </div>
  );
}
