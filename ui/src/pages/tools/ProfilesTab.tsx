import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Layers, Plus, Pencil, Trash2, Link2, ShieldCheck } from "lucide-react";
import type {
  ToolProfileBindingTargetType,
  ToolProfileDefaultAction,
  ToolProfileEntry,
  ToolProfileEntryEffect,
  ToolProfileEntrySelectorType,
  ToolProfileStatus,
  ToolProfileWithDetails,
  ToolRiskLevel,
} from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { projectsApi } from "@/api/projects";
import { routinesApi } from "@/api/routines";
import {
  toolsApi,
  type CreateToolProfileInput,
  type ToolProfileBindingInput,
  type ToolProfileEntryInput,
  type UpdateToolProfileInput,
} from "@/api/tools";
import { ApiError } from "@/api/client";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/context/ToastContext";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState, LoadingState, RelativeTime, RiskBadge, ToolsPageHeader } from "./shared";

const SELECTOR_TYPES: Array<{ value: ToolProfileEntrySelectorType; label: string }> = [
  { value: "tool_name", label: "Tool name" },
  { value: "risk_level", label: "Risk level" },
  { value: "application", label: "Application" },
  { value: "connection", label: "Connection" },
  { value: "catalog_entry", label: "Catalog entry ID" },
];

const TARGET_TYPES: Array<{ value: ToolProfileBindingTargetType; label: string }> = [
  { value: "company", label: "Company" },
  { value: "agent", label: "Agent" },
  { value: "project", label: "Project" },
  { value: "routine", label: "Routine" },
  { value: "issue", label: "Issue ID" },
];

const RISK_LEVELS: ToolRiskLevel[] = ["read", "write", "destructive", "low", "medium", "high", "critical"];

function slugifyProfileKey(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160);
}

function statusVariant(status: ToolProfileStatus): "default" | "secondary" | "outline" | "destructive" {
  if (status === "active") return "default";
  if (status === "archived") return "outline";
  return "secondary";
}

function targetIdForType(input: {
  companyId: string;
  targetType: ToolProfileBindingTargetType;
  agentId: string;
  projectId: string;
  routineId: string;
  issueId: string;
}) {
  if (input.targetType === "company") return input.companyId;
  if (input.targetType === "agent") return input.agentId;
  if (input.targetType === "project") return input.projectId;
  if (input.targetType === "routine") return input.routineId;
  return input.issueId.trim();
}

function buildEntryInput(input: {
  selectorType: ToolProfileEntrySelectorType;
  effect: ToolProfileEntryEffect;
  applicationId: string;
  connectionId: string;
  catalogEntryId: string;
  toolName: string;
  riskLevel: ToolRiskLevel;
}): ToolProfileEntryInput | null {
  const base = { selectorType: input.selectorType, effect: input.effect };
  if (input.selectorType === "application") {
    return input.applicationId ? { ...base, applicationId: input.applicationId } : null;
  }
  if (input.selectorType === "connection") {
    return input.connectionId ? { ...base, connectionId: input.connectionId } : null;
  }
  if (input.selectorType === "catalog_entry") {
    const catalogEntryId = input.catalogEntryId.trim();
    return catalogEntryId ? { ...base, catalogEntryId } : null;
  }
  if (input.selectorType === "tool_name") {
    const toolName = input.toolName.trim();
    return toolName ? { ...base, toolName } : null;
  }
  return { ...base, riskLevel: input.riskLevel };
}

function entryLabel(
  entry: ToolProfileEntry,
  applicationsById: Map<string, string>,
  connectionsById: Map<string, string>,
) {
  if (entry.selectorType === "application") return applicationsById.get(entry.applicationId ?? "") ?? entry.applicationId ?? "application";
  if (entry.selectorType === "connection") return connectionsById.get(entry.connectionId ?? "") ?? entry.connectionId ?? "connection";
  if (entry.selectorType === "catalog_entry") return entry.catalogEntryId ?? "catalog entry";
  if (entry.selectorType === "risk_level") return entry.riskLevel ?? "risk level";
  return entry.toolName ?? "tool";
}

function bindingLabel(
  targetType: ToolProfileBindingTargetType,
  targetId: string,
  labels: {
    companyId: string;
    agentsById: Map<string, string>;
    projectsById: Map<string, string>;
    routinesById: Map<string, string>;
  },
) {
  if (targetType === "company") return targetId === labels.companyId ? "Company" : targetId;
  if (targetType === "agent") return labels.agentsById.get(targetId) ?? targetId;
  if (targetType === "project") return labels.projectsById.get(targetId) ?? targetId;
  if (targetType === "routine") return labels.routinesById.get(targetId) ?? targetId;
  return targetId;
}

function useLookupData(companyId: string) {
  const agents = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
  });
  const projects = useQuery({
    queryKey: queryKeys.projects.list(companyId),
    queryFn: () => projectsApi.list(companyId),
  });
  const routines = useQuery({
    queryKey: queryKeys.routines.list(companyId),
    queryFn: () => routinesApi.list(companyId),
  });
  const applications = useQuery({
    queryKey: queryKeys.tools.applications(companyId),
    queryFn: () => toolsApi.listApplications(companyId),
  });
  const connections = useQuery({
    queryKey: queryKeys.tools.connections(companyId),
    queryFn: () => toolsApi.listConnections(companyId),
  });

  const maps = useMemo(() => ({
    agentsById: new Map((agents.data ?? []).map((agent) => [agent.id, agent.name])),
    projectsById: new Map((projects.data ?? []).map((project) => [project.id, project.name])),
    routinesById: new Map((routines.data ?? []).map((routine) => [routine.id, routine.title])),
    applicationsById: new Map((applications.data?.applications ?? []).map((app) => [app.id, app.name])),
    connectionsById: new Map((connections.data?.connections ?? []).map((conn) => [conn.id, conn.name])),
  }), [agents.data, applications.data, connections.data, projects.data, routines.data]);

  return { agents, projects, routines, applications, connections, maps };
}

function EntryFields({
  selectorType,
  setSelectorType,
  effect,
  setEffect,
  applicationId,
  setApplicationId,
  connectionId,
  setConnectionId,
  catalogEntryId,
  setCatalogEntryId,
  toolName,
  setToolName,
  riskLevel,
  setRiskLevel,
  applications,
  connections,
}: {
  selectorType: ToolProfileEntrySelectorType;
  setSelectorType: (value: ToolProfileEntrySelectorType) => void;
  effect: ToolProfileEntryEffect;
  setEffect: (value: ToolProfileEntryEffect) => void;
  applicationId: string;
  setApplicationId: (value: string) => void;
  connectionId: string;
  setConnectionId: (value: string) => void;
  catalogEntryId: string;
  setCatalogEntryId: (value: string) => void;
  toolName: string;
  setToolName: (value: string) => void;
  riskLevel: ToolRiskLevel;
  setRiskLevel: (value: ToolRiskLevel) => void;
  applications: Array<{ id: string; name: string }>;
  connections: Array<{ id: string; name: string }>;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-[1fr_1fr]">
      <div className="space-y-1.5">
        <Label>Selector</Label>
        <Select value={selectorType} onValueChange={(value) => setSelectorType(value as ToolProfileEntrySelectorType)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SELECTOR_TYPES.map((type) => (
              <SelectItem key={type.value} value={type.value}>
                {type.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label>Effect</Label>
        <Select value={effect} onValueChange={(value) => setEffect(value as ToolProfileEntryEffect)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="include">Include</SelectItem>
            <SelectItem value="exclude">Exclude</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {selectorType === "application" ? (
        <div className="space-y-1.5 sm:col-span-2">
          <Label>Application</Label>
          <Select value={applicationId} onValueChange={setApplicationId}>
            <SelectTrigger>
              <SelectValue placeholder="Select an application" />
            </SelectTrigger>
            <SelectContent>
              {applications.map((app) => (
                <SelectItem key={app.id} value={app.id}>
                  {app.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
      {selectorType === "connection" ? (
        <div className="space-y-1.5 sm:col-span-2">
          <Label>Connection</Label>
          <Select value={connectionId} onValueChange={setConnectionId}>
            <SelectTrigger>
              <SelectValue placeholder="Select a connection" />
            </SelectTrigger>
            <SelectContent>
              {connections.map((conn) => (
                <SelectItem key={conn.id} value={conn.id}>
                  {conn.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
      {selectorType === "catalog_entry" ? (
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="catalog-entry-id">Catalog entry ID</Label>
          <Input id="catalog-entry-id" value={catalogEntryId} onChange={(event) => setCatalogEntryId(event.target.value)} />
        </div>
      ) : null}
      {selectorType === "tool_name" ? (
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="tool-name">Tool name</Label>
          <Input id="tool-name" value={toolName} onChange={(event) => setToolName(event.target.value)} placeholder="e.g. send_email" />
        </div>
      ) : null}
      {selectorType === "risk_level" ? (
        <div className="space-y-1.5 sm:col-span-2">
          <Label>Risk level</Label>
          <Select value={riskLevel} onValueChange={(value) => setRiskLevel(value as ToolRiskLevel)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RISK_LEVELS.map((risk) => (
                <SelectItem key={risk} value={risk}>
                  {risk}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
    </div>
  );
}

function EffectiveAgentPanel({ companyId, agentOptions }: { companyId: string; agentOptions: Array<{ id: string; name: string }> }) {
  const [agentId, setAgentId] = useState("");
  const effective = useQuery({
    queryKey: agentId
      ? queryKeys.tools.effectiveProfilesForAgent(companyId, agentId)
      : ["tools", companyId, "profiles", "effective", "agent", "__none__"],
    queryFn: () => toolsApi.getEffectiveProfilesForAgent(companyId, agentId),
    enabled: Boolean(agentId),
  });

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 py-4">
        <div className="flex flex-wrap items-center gap-3">
          <ShieldCheck className="h-5 w-5 text-muted-foreground" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">Effective agent access</p>
            <p className="text-xs text-muted-foreground">Resolve active company and agent bindings into allowed tool names.</p>
          </div>
          <div className="ml-auto min-w-64">
            <Select value={agentId} onValueChange={setAgentId}>
              <SelectTrigger>
                <SelectValue placeholder="Select an agent" />
              </SelectTrigger>
              <SelectContent>
                {agentOptions.map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>
                    {agent.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        {!agentId ? null : effective.isLoading ? (
          <LoadingState label="Resolving access..." />
        ) : effective.error ? (
          <ErrorState error={effective.error} onRetry={() => effective.refetch()} />
        ) : (
          <div className="flex flex-wrap gap-2">
            {(effective.data?.profiles ?? []).map((profile) => (
              <Badge key={profile.id} variant="secondary">{profile.name}</Badge>
            ))}
            {(effective.data?.allowedToolNames ?? []).slice(0, 24).map((tool) => (
              <Badge key={tool} variant="outline">{tool}</Badge>
            ))}
            {(effective.data?.allowedToolNames ?? []).length === 0 ? (
              <span className="text-sm text-muted-foreground">No allowed tools resolved for this agent.</span>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function ProfilesTab({ companyId }: { companyId: string }) {
  const qc = useQueryClient();
  const { pushToast } = useToast();
  const [createOpen, setCreateOpen] = useState(false);
  const [editProfile, setEditProfile] = useState<ToolProfileWithDetails | null>(null);
  const [entryProfile, setEntryProfile] = useState<ToolProfileWithDetails | null>(null);
  const [bindProfileFor, setBindProfileFor] = useState<ToolProfileWithDetails | null>(null);

  const [name, setName] = useState("");
  const [profileKey, setProfileKey] = useState("");
  const [description, setDescription] = useState("");
  const [defaultAction, setDefaultAction] = useState<ToolProfileDefaultAction>("deny");
  const [status, setStatus] = useState<ToolProfileStatus>("active");

  const [selectorType, setSelectorType] = useState<ToolProfileEntrySelectorType>("tool_name");
  const [effect, setEffect] = useState<ToolProfileEntryEffect>("include");
  const [applicationId, setApplicationId] = useState("");
  const [connectionId, setConnectionId] = useState("");
  const [catalogEntryId, setCatalogEntryId] = useState("");
  const [toolName, setToolName] = useState("");
  const [riskLevel, setRiskLevel] = useState<ToolRiskLevel>("read");

  const [targetType, setTargetType] = useState<ToolProfileBindingTargetType>("agent");
  const [targetAgentId, setTargetAgentId] = useState("");
  const [targetProjectId, setTargetProjectId] = useState("");
  const [targetRoutineId, setTargetRoutineId] = useState("");
  const [targetIssueId, setTargetIssueId] = useState("");
  const [priority, setPriority] = useState("100");

  const lookups = useLookupData(companyId);
  const profiles = useQuery({
    queryKey: queryKeys.tools.profiles(companyId),
    queryFn: () => toolsApi.listProfiles(companyId),
  });

  const applicationOptions = lookups.applications.data?.applications ?? [];
  const connectionOptions = lookups.connections.data?.connections ?? [];
  const agentOptions = lookups.agents.data ?? [];
  const projectOptions = lookups.projects.data ?? [];
  const routineOptions = lookups.routines.data ?? [];

  const invalidateProfiles = () => {
    qc.invalidateQueries({ queryKey: queryKeys.tools.profiles(companyId) });
    qc.invalidateQueries({ queryKey: ["tools", companyId, "profiles", "effective"] });
  };

  const resetProfileForm = () => {
    setName("");
    setProfileKey("");
    setDescription("");
    setDefaultAction("deny");
    setStatus("active");
  };

  const resetEntryForm = () => {
    setSelectorType("tool_name");
    setEffect("include");
    setApplicationId("");
    setConnectionId("");
    setCatalogEntryId("");
    setToolName("");
    setRiskLevel("read");
  };

  const createProfile = useMutation({
    mutationFn: (input: CreateToolProfileInput) => toolsApi.createProfile(companyId, input),
    onSuccess: () => {
      invalidateProfiles();
      setCreateOpen(false);
      resetProfileForm();
      resetEntryForm();
      pushToast({ title: "Profile created", tone: "success" });
    },
    onError: (error) => pushToast({
      title: "Could not create profile",
      body: error instanceof ApiError ? error.message : String(error),
      tone: "error",
    }),
  });

  const updateProfile = useMutation({
    mutationFn: ({ profileId, input }: { profileId: string; input: UpdateToolProfileInput }) =>
      toolsApi.updateProfile(profileId, input),
    onSuccess: () => {
      invalidateProfiles();
      setEditProfile(null);
      resetProfileForm();
      pushToast({ title: "Profile updated", tone: "success" });
    },
    onError: (error) => pushToast({
      title: "Could not update profile",
      body: error instanceof ApiError ? error.message : String(error),
      tone: "error",
    }),
  });

  const addEntry = useMutation({
    mutationFn: ({ profileId, input }: { profileId: string; input: ToolProfileEntryInput }) =>
      toolsApi.addProfileEntry(profileId, input),
    onSuccess: () => {
      invalidateProfiles();
      setEntryProfile(null);
      resetEntryForm();
      pushToast({ title: "Entry added", tone: "success" });
    },
    onError: (error) => pushToast({
      title: "Could not add entry",
      body: error instanceof ApiError ? error.message : String(error),
      tone: "error",
    }),
  });

  const deleteEntry = useMutation({
    mutationFn: (entryId: string) => toolsApi.deleteProfileEntry(entryId),
    onSuccess: () => {
      invalidateProfiles();
      pushToast({ title: "Entry removed", tone: "success" });
    },
    onError: (error) => pushToast({
      title: "Could not remove entry",
      body: error instanceof ApiError ? error.message : String(error),
      tone: "error",
    }),
  });

  const bind = useMutation({
    mutationFn: ({ profileId, input }: { profileId: string; input: ToolProfileBindingInput }) =>
      toolsApi.bindProfile(companyId, profileId, input),
    onSuccess: () => {
      invalidateProfiles();
      setBindProfileFor(null);
      setTargetType("agent");
      setPriority("100");
      pushToast({ title: "Profile bound", tone: "success" });
    },
    onError: (error) => pushToast({
      title: "Could not bind profile",
      body: error instanceof ApiError ? error.message : String(error),
      tone: "error",
    }),
  });

  const unbind = useMutation({
    mutationFn: ({ profileId, targetType, targetId }: {
      profileId: string;
      targetType: ToolProfileBindingTargetType;
      targetId: string;
    }) => toolsApi.unbindProfile(companyId, profileId, { targetType, targetId }),
    onSuccess: () => {
      invalidateProfiles();
      pushToast({ title: "Binding removed", tone: "success" });
    },
    onError: (error) => pushToast({
      title: "Could not remove binding",
      body: error instanceof ApiError ? error.message : String(error),
      tone: "error",
    }),
  });

  if (profiles.isLoading) return <LoadingState />;
  if (profiles.error) return <ErrorState error={profiles.error} onRetry={() => profiles.refetch()} />;

  const list = profiles.data?.profiles ?? [];

  const openEdit = (profile: ToolProfileWithDetails) => {
    setEditProfile(profile);
    setName(profile.name);
    setProfileKey(profile.profileKey);
    setDescription(profile.description ?? "");
    setDefaultAction(profile.defaultAction);
    setStatus(profile.status);
  };

  const saveProfile = () => {
    const key = profileKey.trim() || slugifyProfileKey(name);
    if (!name.trim() || !key) return;
    if (editProfile) {
      updateProfile.mutate({
        profileId: editProfile.id,
        input: {
          name: name.trim(),
          profileKey: key,
          description: description.trim() || null,
          defaultAction,
          status,
        },
      });
      return;
    }
    const entry = buildEntryInput({
      selectorType,
      effect,
      applicationId,
      connectionId,
      catalogEntryId,
      toolName,
      riskLevel,
    });
    createProfile.mutate({
      name: name.trim(),
      profileKey: key,
      description: description.trim() || null,
      defaultAction,
      status,
      entries: entry ? [entry] : [],
    });
  };

  const saveEntry = () => {
    if (!entryProfile) return;
    const entry = buildEntryInput({
      selectorType,
      effect,
      applicationId,
      connectionId,
      catalogEntryId,
      toolName,
      riskLevel,
    });
    if (!entry) {
      pushToast({ title: "Entry target required", tone: "error" });
      return;
    }
    addEntry.mutate({ profileId: entryProfile.id, input: entry });
  };

  const saveBinding = () => {
    if (!bindProfileFor) return;
    const targetId = targetIdForType({
      companyId,
      targetType,
      agentId: targetAgentId,
      projectId: targetProjectId,
      routineId: targetRoutineId,
      issueId: targetIssueId,
    });
    if (!targetId) {
      pushToast({ title: "Binding target required", tone: "error" });
      return;
    }
    bind.mutate({
      profileId: bindProfileFor.id,
      input: {
        targetType,
        targetId,
        priority: Number(priority) || 100,
      },
    });
  };

  return (
    <div className="space-y-4">
      <ToolsPageHeader
        title="Access profiles"
        description="Reusable bundles of allowed applications, connections, and tools, assignable to agents, projects, routines, or issues."
        actions={
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="mr-1 h-4 w-4" />
            New profile
          </Button>
        }
      />

      <EffectiveAgentPanel companyId={companyId} agentOptions={agentOptions} />

      {list.length === 0 ? (
        <EmptyState
          icon={Layers}
          message="No access profiles yet"
          description="Create a profile to group tool selectors, then bind it to the company or a specific agent."
          action="New profile"
          onAction={() => setCreateOpen(true)}
        />
      ) : (
        <div className="grid gap-3">
          {list.map((profile) => (
            <Card key={profile.id}>
              <CardContent className="space-y-3 py-4">
                <div className="flex flex-wrap items-start gap-3">
                  <Layers className="mt-0.5 h-5 w-5 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-foreground">{profile.name}</span>
                      <Badge variant="outline">{profile.profileKey}</Badge>
                      <Badge variant={statusVariant(profile.status)}>{profile.status}</Badge>
                      <Badge variant={profile.defaultAction === "allow" ? "secondary" : "outline"}>
                        default {profile.defaultAction}
                      </Badge>
                    </div>
                    {profile.description ? (
                      <p className="mt-1 text-sm text-muted-foreground">{profile.description}</p>
                    ) : null}
                    <p className="mt-1 text-xs text-muted-foreground">
                      {profile.entries.length} entries / {profile.bindings.length} bindings / updated{" "}
                      <RelativeTime value={profile.updatedAt} />
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-1.5">
                    <Button size="sm" variant="outline" onClick={() => openEdit(profile)}>
                      <Pencil className="mr-1 h-3.5 w-3.5" />
                      Edit
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => {
                      setEntryProfile(profile);
                      resetEntryForm();
                    }}>
                      <Plus className="mr-1 h-3.5 w-3.5" />
                      Entry
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setBindProfileFor(profile)}>
                      <Link2 className="mr-1 h-3.5 w-3.5" />
                      Bind
                    </Button>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {profile.entries.length === 0 ? (
                    <span className="text-sm text-muted-foreground">No entries.</span>
                  ) : profile.entries.map((entry) => (
                    <span key={entry.id} className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs">
                      <Badge variant={entry.effect === "include" ? "secondary" : "destructive"}>{entry.effect}</Badge>
                      <span className="font-mono">{entry.selectorType}</span>
                      {entry.selectorType === "risk_level" ? <RiskBadge risk={entry.riskLevel} /> : (
                        <span className="max-w-64 truncate">{entryLabel(entry, lookups.maps.applicationsById, lookups.maps.connectionsById)}</span>
                      )}
                      <button
                        type="button"
                        className="rounded p-0.5 text-muted-foreground hover:text-destructive"
                        onClick={() => deleteEntry.mutate(entry.id)}
                        aria-label={`Delete ${entry.selectorType} entry`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  ))}
                </div>
                <div className="flex flex-wrap gap-2">
                  {profile.bindings.length === 0 ? (
                    <span className="text-sm text-muted-foreground">No bindings.</span>
                  ) : profile.bindings.map((binding) => (
                    <span key={binding.id} className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs">
                      <Badge variant="outline">{binding.targetType}</Badge>
                      <span>{bindingLabel(binding.targetType, binding.targetId, { companyId, ...lookups.maps })}</span>
                      <span className="text-muted-foreground">p{binding.priority}</span>
                      <button
                        type="button"
                        className="rounded p-0.5 text-muted-foreground hover:text-destructive"
                        onClick={() => unbind.mutate({
                          profileId: profile.id,
                          targetType: binding.targetType,
                          targetId: binding.targetId,
                        })}
                        aria-label={`Remove ${binding.targetType} binding`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={createOpen || Boolean(editProfile)} onOpenChange={(open) => {
        if (!open) {
          setCreateOpen(false);
          setEditProfile(null);
          resetProfileForm();
          resetEntryForm();
        }
      }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editProfile ? "Edit profile" : "New profile"}</DialogTitle>
            <DialogDescription>
              Profile rules are enforced by the tool gateway policy service.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="profile-name">Name</Label>
                <Input
                  id="profile-name"
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                    if (!editProfile && !profileKey.trim()) setProfileKey(slugifyProfileKey(event.target.value));
                  }}
                  placeholder="Engineering write tools"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="profile-key">Key</Label>
                <Input id="profile-key" value={profileKey} onChange={(event) => setProfileKey(event.target.value)} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="profile-description">Description</Label>
              <Textarea
                id="profile-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Optional context for reviewers."
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Default action</Label>
                <Select value={defaultAction} onValueChange={(value) => setDefaultAction(value as ToolProfileDefaultAction)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="deny">Deny unless included</SelectItem>
                    <SelectItem value="allow">Allow unless excluded</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Status</Label>
                <Select value={status} onValueChange={(value) => setStatus(value as ToolProfileStatus)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="disabled">Disabled</SelectItem>
                    <SelectItem value="archived">Archived</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            {!editProfile ? (
              <EntryFields
                selectorType={selectorType}
                setSelectorType={setSelectorType}
                effect={effect}
                setEffect={setEffect}
                applicationId={applicationId}
                setApplicationId={setApplicationId}
                connectionId={connectionId}
                setConnectionId={setConnectionId}
                catalogEntryId={catalogEntryId}
                setCatalogEntryId={setCatalogEntryId}
                toolName={toolName}
                setToolName={setToolName}
                riskLevel={riskLevel}
                setRiskLevel={setRiskLevel}
                applications={applicationOptions}
                connections={connectionOptions}
              />
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => {
              setCreateOpen(false);
              setEditProfile(null);
              resetProfileForm();
              resetEntryForm();
            }}>
              Cancel
            </Button>
            <Button disabled={!name.trim() || createProfile.isPending || updateProfile.isPending} onClick={saveProfile}>
              {editProfile ? "Save" : createProfile.isPending ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(entryProfile)} onOpenChange={(open) => {
        if (!open) {
          setEntryProfile(null);
          resetEntryForm();
        }
      }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Add entry</DialogTitle>
            <DialogDescription>{entryProfile?.name}</DialogDescription>
          </DialogHeader>
          <EntryFields
            selectorType={selectorType}
            setSelectorType={setSelectorType}
            effect={effect}
            setEffect={setEffect}
            applicationId={applicationId}
            setApplicationId={setApplicationId}
            connectionId={connectionId}
            setConnectionId={setConnectionId}
            catalogEntryId={catalogEntryId}
            setCatalogEntryId={setCatalogEntryId}
            toolName={toolName}
            setToolName={setToolName}
            riskLevel={riskLevel}
            setRiskLevel={setRiskLevel}
            applications={applicationOptions}
            connections={connectionOptions}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setEntryProfile(null)}>Cancel</Button>
            <Button disabled={addEntry.isPending} onClick={saveEntry}>
              Add entry
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(bindProfileFor)} onOpenChange={(open) => {
        if (!open) setBindProfileFor(null);
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Bind profile</DialogTitle>
            <DialogDescription>{bindProfileFor?.name}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Target type</Label>
              <Select value={targetType} onValueChange={(value) => setTargetType(value as ToolProfileBindingTargetType)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TARGET_TYPES.map((target) => (
                    <SelectItem key={target.value} value={target.value}>
                      {target.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {targetType === "agent" ? (
              <div className="space-y-1.5">
                <Label>Agent</Label>
                <Select value={targetAgentId} onValueChange={setTargetAgentId}>
                  <SelectTrigger><SelectValue placeholder="Select an agent" /></SelectTrigger>
                  <SelectContent>
                    {agentOptions.map((agent) => <SelectItem key={agent.id} value={agent.id}>{agent.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            {targetType === "project" ? (
              <div className="space-y-1.5">
                <Label>Project</Label>
                <Select value={targetProjectId} onValueChange={setTargetProjectId}>
                  <SelectTrigger><SelectValue placeholder="Select a project" /></SelectTrigger>
                  <SelectContent>
                    {projectOptions.map((project) => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            {targetType === "routine" ? (
              <div className="space-y-1.5">
                <Label>Routine</Label>
                <Select value={targetRoutineId} onValueChange={setTargetRoutineId}>
                  <SelectTrigger><SelectValue placeholder="Select a routine" /></SelectTrigger>
                  <SelectContent>
                    {routineOptions.map((routine) => <SelectItem key={routine.id} value={routine.id}>{routine.title}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            {targetType === "issue" ? (
              <div className="space-y-1.5">
                <Label htmlFor="target-issue-id">Issue ID</Label>
                <Input id="target-issue-id" value={targetIssueId} onChange={(event) => setTargetIssueId(event.target.value)} />
              </div>
            ) : null}
            <div className="space-y-1.5">
              <Label htmlFor="profile-priority">Priority</Label>
              <Input id="profile-priority" type="number" min={0} max={10000} value={priority} onChange={(event) => setPriority(event.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBindProfileFor(null)}>Cancel</Button>
            <Button disabled={bind.isPending} onClick={saveBinding}>
              Bind
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
