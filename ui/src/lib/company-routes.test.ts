import { describe, expect, it } from "vitest";
import {
  applyCompanyPrefix,
  extractCompanyPrefixFromPath,
  isBoardPathWithoutPrefix,
  toCompanyRelativePath,
} from "./company-routes";

describe("company routes", () => {
  it("treats execution workspace paths as board routes that need a company prefix", () => {
    expect(isBoardPathWithoutPrefix("/execution-workspaces/workspace-123")).toBe(true);
    expect(isBoardPathWithoutPrefix("/execution-workspaces/workspace-123/routines")).toBe(true);
    expect(extractCompanyPrefixFromPath("/execution-workspaces/workspace-123")).toBeNull();
    expect(applyCompanyPrefix("/execution-workspaces/workspace-123", "PAP")).toBe(
      "/PAP/execution-workspaces/workspace-123",
    );
    expect(applyCompanyPrefix("/execution-workspaces/workspace-123/routines", "PAP")).toBe(
      "/PAP/execution-workspaces/workspace-123/routines",
    );
  });

  it("normalizes prefixed execution workspace paths back to company-relative paths", () => {
    expect(toCompanyRelativePath("/PAP/execution-workspaces/workspace-123")).toBe(
      "/execution-workspaces/workspace-123",
    );
    expect(toCompanyRelativePath("/PAP/execution-workspaces/workspace-123/routines")).toBe(
      "/execution-workspaces/workspace-123/routines",
    );
  });

  it("treats /search as a board route that needs a company prefix", () => {
    expect(isBoardPathWithoutPrefix("/search")).toBe(true);
    expect(extractCompanyPrefixFromPath("/search")).toBeNull();
    expect(applyCompanyPrefix("/search", "PAP")).toBe("/PAP/search");
    expect(applyCompanyPrefix("/search?q=hello%20world", "PAP")).toBe("/PAP/search?q=hello%20world");
    expect(toCompanyRelativePath("/PAP/search?q=foo")).toBe("/search?q=foo");
  });

  // Regression for PAP-10257: Team Catalog navigation (auto-select + row/file
  // clicks) produces company-relative `/teams/<key>` paths. Without `teams` in
  // the board-route allowlist, `extractCompanyPrefixFromPath` misread the first
  // segment as a company prefix ("TEAMS") and `useNavigate` skipped the rewrite,
  // dropping the `/PAP/` prefix and crashing into "Company not found".
  it("re-prefixes team catalog routes so navigate preserves the company prefix", () => {
    expect(isBoardPathWithoutPrefix("/teams")).toBe(true);
    expect(isBoardPathWithoutPrefix("/teams/core-exec-team")).toBe(true);
    expect(extractCompanyPrefixFromPath("/teams/core-exec-team")).toBeNull();

    // Auto-select effect: `/teams/<first-key>` must gain the `/PAP/` prefix.
    expect(applyCompanyPrefix("/teams/core-exec-team", "PAP")).toBe("/PAP/teams/core-exec-team");
    // File-tree click: nested `/files/<encoded>` path is preserved under the prefix.
    expect(applyCompanyPrefix("/teams/core-exec-team/files/TEAM.md", "PAP")).toBe(
      "/PAP/teams/core-exec-team/files/TEAM.md",
    );
    // Already-prefixed paths are left untouched (idempotent — no double prefix).
    expect(applyCompanyPrefix("/PAP/teams/core-exec-team", "PAP")).toBe("/PAP/teams/core-exec-team");
    // Round-trips back to a company-relative path.
    expect(toCompanyRelativePath("/PAP/teams/core-exec-team")).toBe("/teams/core-exec-team");
  });
});
