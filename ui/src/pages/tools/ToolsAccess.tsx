import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AppWindow,
  ClipboardList,
  Layers,
  Plug,
  ScrollText,
  Server,
  Shield,
  Sparkles,
} from "lucide-react";
import { Link, useParams } from "@/lib/router";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { cn } from "@/lib/utils";
import { queryKeys } from "@/lib/queryKeys";
import { toolsApi } from "@/api/tools";
import { EnforcementBanner } from "@/components/EnforcementBanner";
import { OverviewTab } from "./OverviewTab";
import { ApplicationsTab } from "./ApplicationsTab";
import { ConnectionsTab } from "./ConnectionsTab";
import { ProfilesTab } from "./ProfilesTab";
import { PoliciesTab } from "./PoliciesTab";
import { RuntimeTab } from "./RuntimeTab";
import { AuditTab } from "./AuditTab";
import { ExamplesTab } from "./ExamplesTab";

const TABS = [
  { key: "overview", label: "Overview", icon: Activity },
  { key: "applications", label: "Applications", icon: AppWindow },
  { key: "connections", label: "Connections", icon: Plug },
  { key: "profiles", label: "Profiles", icon: Layers },
  { key: "policies", label: "Policies", icon: Shield },
  { key: "runtime", label: "Runtime", icon: Server },
  { key: "audit", label: "Audit", icon: ScrollText },
  { key: "examples", label: "Examples", icon: Sparkles },
] as const;

type TabKey = (typeof TABS)[number]["key"];

function renderTab(tab: TabKey, companyId: string) {
  switch (tab) {
    case "applications":
      return <ApplicationsTab companyId={companyId} />;
    case "connections":
      return <ConnectionsTab companyId={companyId} />;
    case "profiles":
      return <ProfilesTab companyId={companyId} />;
    case "policies":
      return <PoliciesTab companyId={companyId} />;
    case "runtime":
      return <RuntimeTab companyId={companyId} />;
    case "audit":
      return <AuditTab companyId={companyId} />;
    case "examples":
      return <ExamplesTab companyId={companyId} />;
    case "overview":
    default:
      return <OverviewTab companyId={companyId} />;
  }
}

export function ToolsAccess() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const params = useParams<{ tab?: string }>();
  const activeTab = (TABS.find((t) => t.key === params.tab)?.key ?? "overview") as TabKey;

  // Drives the live cyan dot on the Runtime tab when any slot is running.
  const runtimeSlots = useQuery({
    queryKey: queryKeys.tools.runtimeSlots(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listRuntimeSlots(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 15_000,
  });
  const runtimeActive = (runtimeSlots.data?.runtimeSlots ?? []).some((s) => s.status === "running");

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Settings", href: "/company/settings" },
      { label: "Tools & Access" },
    ]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs, selectedCompany?.name]);

  if (!selectedCompanyId) {
    return <div className="p-6 text-sm text-muted-foreground">Select a company to manage tools &amp; access.</div>;
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 p-4 sm:p-6">
      <div className="flex items-center gap-2">
        <ClipboardList className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-xl font-bold text-foreground">Tools &amp; Access</h1>
      </div>
      <EnforcementBanner companyId={selectedCompanyId} />

      <nav className="-mx-1 flex gap-1 overflow-x-auto whitespace-nowrap border-b border-border px-1">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = tab.key === activeTab;
          const showLiveDot = tab.key === "runtime" && runtimeActive;
          return (
            <Link
              key={tab.key}
              to={`/company/settings/tools/${tab.key}`}
              className={cn(
                "flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="h-4 w-4" />
              {tab.label}
              {showLiveDot ? (
                <span
                  className="ml-0.5 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-cyan-500"
                  aria-label="runtime active"
                />
              ) : null}
            </Link>
          );
        })}
      </nav>

      <div className="min-h-[300px]">{renderTab(activeTab, selectedCompanyId)}</div>
    </div>
  );
}
