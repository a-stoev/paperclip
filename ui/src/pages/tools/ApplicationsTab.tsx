import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AppWindow, Plus } from "lucide-react";
import type { ToolApplicationType } from "@paperclipai/shared";
import { queryKeys } from "@/lib/queryKeys";
import { toolsApi, type CreateToolApplicationInput } from "@/api/tools";
import { ApiError } from "@/api/client";
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
import { EmptyState } from "@/components/EmptyState";
import { ToolsPageHeader, LoadingState, ErrorState, RelativeTime } from "./shared";

const APP_TYPES: { value: ToolApplicationType; label: string }[] = [
  { value: "mcp_http", label: "MCP server (remote HTTP)" },
  { value: "mcp_stdio", label: "MCP server (local stdio)" },
  { value: "paperclip_plugin", label: "Paperclip plugin tools" },
];

function statusVariant(status: string): "default" | "secondary" | "outline" | "destructive" {
  if (status === "active" || status === "enabled") return "default";
  if (status === "archived" || status === "disabled") return "outline";
  return "secondary";
}

export function ApplicationsTab({ companyId }: { companyId: string }) {
  const qc = useQueryClient();
  const { pushToast } = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState<ToolApplicationType>("mcp_http");

  const apps = useQuery({
    queryKey: queryKeys.tools.applications(companyId),
    queryFn: () => toolsApi.listApplications(companyId),
  });

  const create = useMutation({
    mutationFn: (input: CreateToolApplicationInput) => toolsApi.createApplication(companyId, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.tools.applications(companyId) });
      setOpen(false);
      setName("");
      setDescription("");
      setType("mcp_http");
      pushToast({ title: "Application created", tone: "success" });
    },
    onError: (err) => {
      pushToast({
        title: "Could not create application",
        body: err instanceof ApiError ? err.message : String(err),
        tone: "error",
      });
    },
  });

  if (apps.isLoading) return <LoadingState />;
  if (apps.error) return <ErrorState error={apps.error} onRetry={() => apps.refetch()} />;

  const list = apps.data?.applications ?? [];

  return (
    <div className="space-y-4">
      <ToolsPageHeader
        title="Applications"
        description="External tool sources: MCP servers and Paperclip plugin tool bundles. Add a connection to each application to discover its tools."
        actions={
          <Button size="sm" onClick={() => setOpen(true)}>
            <Plus className="mr-1 h-4 w-4" />
            New application
          </Button>
        }
      />

      {list.length === 0 ? (
        <EmptyState
          icon={AppWindow}
          message="No applications yet"
          description="Register an MCP server or plugin tool bundle to start governing tool access."
          action="New application"
          onAction={() => setOpen(true)}
        />
      ) : (
        <div className="grid gap-3">
          {list.map((app) => (
            <Card key={app.id}>
              <CardContent className="flex flex-wrap items-center gap-3 py-4">
                <AppWindow className="h-5 w-5 text-muted-foreground" />
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-foreground">{app.name}</span>
                    <Badge variant="outline">{app.type}</Badge>
                    <Badge variant={statusVariant(app.status)}>{app.status}</Badge>
                  </div>
                  {app.description ? (
                    <p className="truncate text-sm text-muted-foreground">{app.description}</p>
                  ) : null}
                </div>
                <span className="ml-auto text-xs">
                  updated <RelativeTime value={app.updatedAt} />
                </span>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New application</DialogTitle>
            <DialogDescription>
              Define a tool source. You will add a connection (credentials + transport) next.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="app-name">Name</Label>
              <Input
                id="app-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. GitHub Triage"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="app-desc">Description</Label>
              <Input
                id="app-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Optional"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Type</Label>
              <Select value={type} onValueChange={(v) => setType(v as ToolApplicationType)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {APP_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!name.trim() || create.isPending}
              onClick={() =>
                create.mutate({
                  name: name.trim(),
                  description: description.trim() || null,
                  type,
                })
              }
            >
              {create.isPending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
