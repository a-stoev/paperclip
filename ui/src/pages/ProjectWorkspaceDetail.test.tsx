// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Project, ProjectWorkspace } from "@paperclipai/shared";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectWorkspaceDetail } from "./ProjectWorkspaceDetail";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockProjectsApi = vi.hoisted(() => ({
  get: vi.fn(),
  updateWorkspace: vi.fn(),
  controlWorkspaceCommands: vi.fn(),
}));
const mockNavigate = vi.hoisted(() => vi.fn());
const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockSetSelectedCompanyId = vi.hoisted(() => vi.fn());
const mockUsePluginSlots = vi.hoisted(() => vi.fn());
const mockPluginSlotMount = vi.hoisted(() => vi.fn());
const mockRouteSearch = vi.hoisted(() => ({ value: "" }));

vi.mock("../api/projects", () => ({ projectsApi: mockProjectsApi }));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children?: ReactNode; to: string }) => <a href={to}>{children}</a>,
  useLocation: () => ({
    pathname: "/PAP/projects/paperclip-app/workspaces/workspace-1",
    search: mockRouteSearch.value,
    hash: "",
    state: null,
  }),
  useNavigate: () => mockNavigate,
  useParams: () => ({ companyPrefix: "PAP", projectId: "paperclip-app", workspaceId: "workspace-1" }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [{ id: "company-1", issuePrefix: "PAP" }],
    selectedCompanyId: "company-1",
    setSelectedCompanyId: mockSetSelectedCompanyId,
  }),
}));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }) }));
vi.mock("../components/PathInstructionsModal", () => ({ ChoosePathButton: () => null }));
vi.mock("../components/WorkspaceRuntimeControls", () => ({
  buildWorkspaceRuntimeControlSections: () => [],
  WorkspaceRuntimeControls: () => <div data-testid="runtime-controls" />,
}));
vi.mock("@/plugins/slots", () => ({
  PluginSlotMount: (props: unknown) => {
    mockPluginSlotMount(props);
    return <div data-testid="plugin-slot-mount" />;
  },
  usePluginSlots: (filters: unknown) => {
    mockUsePluginSlots(filters);
    return {
      slots: [
        {
          id: "workspace-changes-tab",
          type: "detailTab",
          displayName: "Changes",
          exportName: "WorkspaceChangesTab",
          entityTypes: ["project_workspace"],
          pluginId: "plugin-1",
          pluginKey: "paperclip.workspace-diff",
          pluginDisplayName: "Workspace Diff",
          pluginVersion: "0.1.0",
        },
      ],
      isLoading: false,
      errorMessage: null,
    };
  },
}));
vi.mock("../components/PageTabBar", () => ({
  PageTabBar: ({
    items,
    onValueChange,
  }: {
    items: Array<{ value: string; label: string }>;
    onValueChange?: (value: string) => void;
  }) => (
    <div data-testid="page-tab-bar">
      {items.map((item) => (
        <button
          key={item.value}
          data-tab-value={item.value}
          type="button"
          onClick={() => onValueChange?.(item.value)}
        >
          {item.label}
        </button>
      ))}
    </div>
  ),
}));

function projectWorkspace(overrides: Partial<ProjectWorkspace> = {}): ProjectWorkspace {
  const now = new Date("2026-05-01T00:00:00Z");
  return {
    id: "workspace-1",
    companyId: "company-1",
    projectId: "project-1",
    name: "Primary checkout",
    sourceType: "local_path",
    cwd: "/tmp/paperclip",
    repoUrl: "https://github.com/paperclipai/paperclip",
    repoRef: "master",
    defaultRef: "origin/main",
    visibility: "default",
    setupCommand: null,
    cleanupCommand: null,
    remoteProvider: null,
    remoteWorkspaceRef: null,
    sharedWorkspaceKey: null,
    metadata: null,
    runtimeConfig: null,
    runtimeServices: [],
    isPrimary: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function project(overrides: Partial<Project> = {}): Project {
  const now = new Date("2026-05-01T00:00:00Z");
  const workspace = projectWorkspace();
  return {
    id: "project-1",
    companyId: "company-1",
    urlKey: "paperclip-app",
    goalId: null,
    goalIds: [],
    goals: [],
    name: "Paperclip App",
    description: null,
    status: "in_progress",
    leadAgentId: null,
    targetDate: null,
    color: "#14b8a6",
    env: null,
    pauseReason: null,
    pausedAt: null,
    executionWorkspacePolicy: null,
    codebase: {
      workspaceId: workspace.id,
      repoUrl: workspace.repoUrl,
      repoRef: workspace.repoRef,
      defaultRef: workspace.defaultRef,
      repoName: "paperclip",
      localFolder: workspace.cwd,
      managedFolder: workspace.cwd ?? "/tmp/paperclip",
      effectiveLocalFolder: workspace.cwd ?? "/tmp/paperclip",
      origin: "local_folder",
    },
    workspaces: [workspace],
    primaryWorkspace: workspace,
    managedByPlugin: null,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("ProjectWorkspaceDetail changes tab", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockProjectsApi.get.mockResolvedValue(project());
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
    vi.clearAllMocks();
    mockRouteSearch.value = "";
  });

  async function render() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root = createRoot(container);
      root.render(
        <QueryClientProvider client={queryClient}>
          <ProjectWorkspaceDetail />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await flush();
    });
  }

  it("shows Changes as a first-class tab and maps the legacy plugin tab URL to it", async () => {
    mockRouteSearch.value =
      "?tab=plugin%3Apaperclip.workspace-diff%3Aworkspace-changes-tab&diffView=head&baseRef=origin%2Fmaster";

    await render();

    expect(container.querySelector('[data-tab-value="configuration"]')?.textContent).toBe("Configuration");
    expect(container.querySelector('[data-tab-value="changes"]')?.textContent).toBe("Changes");
    expect(container.querySelector('[data-testid="plugin-slot-mount"]')).not.toBeNull();
    expect(mockPluginSlotMount).toHaveBeenCalledWith(
      expect.objectContaining({
        slot: expect.objectContaining({ pluginKey: "paperclip.workspace-diff", id: "workspace-changes-tab" }),
        context: expect.objectContaining({ entityType: "project_workspace", entityId: "workspace-1" }),
      }),
    );
  });

  it("opens the Changes tab in upstream comparison mode", async () => {
    await render();

    await act(async () => {
      (container.querySelector('[data-tab-value="changes"]') as HTMLButtonElement).click();
    });

    expect(mockNavigate).toHaveBeenCalledWith(
      "/projects/paperclip-app/workspaces/workspace-1?tab=changes&diffView=head&baseRef=origin%2Fmain",
    );
  });
});
