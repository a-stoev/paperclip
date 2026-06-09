import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  pipelineAutomationExecutions,
  pipelineCaseBlockers,
  pipelineCaseEvents,
  pipelineCases,
  pipelineStages,
  pipelineTransitions,
  pipelines,
  routines,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { pipelineService, type PipelineActor } from "../services/pipelines.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres pipeline service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("pipelineService", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof pipelineService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const userActor: PipelineActor = { type: "user", userId: "board-user" };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pipelines-service-");
    db = createDb(tempDb.connectionString);
    svc = pipelineService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(pipelineAutomationExecutions);
    await db.delete(pipelineCaseBlockers);
    await db.delete(pipelineCaseEvents);
    await db.delete(pipelineCases);
    await db.delete(pipelineTransitions);
    await db.delete(pipelineStages);
    await db.delete(pipelines);
    await db.delete(routines);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const [company] = await db.insert(companies).values({
      name: "Pipeline Co",
      issuePrefix: `P${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    }).returning();
    return company!;
  }

  async function seedPipeline(options?: { enforceTransitions?: boolean }) {
    const company = await seedCompany();
    const pipeline = await svc.createPipeline({
      companyId: company.id,
      key: `content-${randomUUID().slice(0, 8)}`,
      name: "Content",
      enforceTransitions: options?.enforceTransitions ?? false,
      actor: userActor,
    });
    const stages = await svc.listStages(company.id, pipeline.id);
    return { company, pipeline, stages, byKey: new Map(stages.map((stage) => [stage.key, stage])) };
  }

  async function eventCount(caseId: string) {
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(pipelineCaseEvents)
      .where(eq(pipelineCaseEvents.caseId, caseId));
    return count ?? 0;
  }

  it("seeds default stages and protects non-empty stage deletion", async () => {
    const { company, pipeline, byKey } = await seedPipeline();

    expect([...byKey.keys()]).toEqual(["intake", "in_progress", "review", "done", "cancelled"]);
    const created = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "stage-delete",
      title: "Stage delete guard",
      actor: userActor,
    });

    await expect(
      svc.deleteStage({ companyId: company.id, pipelineId: pipeline.id, stageId: byKey.get("intake")!.id }),
    ).rejects.toMatchObject({ status: 422, details: { code: "stage_has_cases" } });

    await svc.deleteStage({
      companyId: company.id,
      pipelineId: pipeline.id,
      stageId: byKey.get("intake")!.id,
      moveCasesToStageId: byKey.get("in_progress")!.id,
    });
    const [moved] = await db.select().from(pipelineCases).where(eq(pipelineCases.id, created.case.id));
    expect(moved!.stageId).toBe(byKey.get("in_progress")!.id);
  });

  it("implements idempotent single and batch ingest", async () => {
    const { company, pipeline } = await seedPipeline();

    const first = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "release-1",
      title: "Release 1",
      actor: userActor,
    });
    const second = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "release-1",
      title: "Duplicate title is ignored",
      actor: userActor,
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.case.id).toBe(first.case.id);
    expect(await eventCount(first.case.id)).toBe(1);

    await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "existing-2",
      title: "Existing 2",
      actor: userActor,
    });
    const batch = await svc.ingestCases({
      companyId: company.id,
      pipelineId: pipeline.id,
      actor: userActor,
      items: [
        { caseKey: "new-1", title: "New 1" },
        { caseKey: "new-2", title: "New 2" },
        { caseKey: "release-1", title: "Existing 1" },
        { caseKey: "new-3", title: "New 3" },
        { caseKey: "existing-2", title: "Existing 2 again" },
      ],
    });

    expect(batch).toHaveLength(5);
    expect(batch.filter((item) => item.ok && item.created)).toHaveLength(3);
    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(pipelineCases);
    expect(count).toBe(5);
  });

  it("rejects stale content PATCH without writing an event", async () => {
    const { company, pipeline } = await seedPipeline();
    const created = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "patch",
      title: "Patch me",
      actor: userActor,
    });
    await svc.patchCaseContent({
      companyId: company.id,
      caseId: created.case.id,
      title: "Patched",
      expectedVersion: 1,
      actor: userActor,
    });
    const before = await eventCount(created.case.id);

    await expect(
      svc.patchCaseContent({
        companyId: company.id,
        caseId: created.case.id,
        title: "Stale",
        expectedVersion: 1,
        actor: userActor,
      }),
    ).rejects.toMatchObject({ status: 409, details: { code: "version_conflict", version: 2 } });
    expect(await eventCount(created.case.id)).toBe(before);
  });

  it("lets exactly one parallel transition with the same expectedVersion succeed", async () => {
    const { company, pipeline } = await seedPipeline();
    const created = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "parallel",
      title: "Parallel transition",
      actor: userActor,
    });

    const attempts = await Promise.allSettled([
      svc.transitionCase({
        companyId: company.id,
        caseId: created.case.id,
        toStageKey: "in_progress",
        expectedVersion: 1,
        actor: userActor,
      }),
      svc.transitionCase({
        companyId: company.id,
        caseId: created.case.id,
        toStageKey: "review",
        expectedVersion: 1,
        actor: userActor,
      }),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    const [row] = await db.select().from(pipelineCases).where(eq(pipelineCases.id, created.case.id));
    expect(row!.version).toBe(2);
    expect(await eventCount(created.case.id)).toBe(2);
  });

  it("enforces active leases and lets the holder transition with the lease token", async () => {
    const { company, pipeline } = await seedPipeline();
    const created = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "lease",
      title: "Leased case",
      actor: userActor,
    });
    const owner: PipelineActor = { type: "user", userId: "owner" };
    const other: PipelineActor = { type: "user", userId: "other" };

    const claimed = await svc.claimCase({ companyId: company.id, caseId: created.case.id, actor: owner });
    await expect(svc.claimCase({ companyId: company.id, caseId: created.case.id, actor: other })).rejects.toMatchObject({
      status: 409,
      details: { code: "lease_held" },
    });
    await expect(
      svc.transitionCase({
        companyId: company.id,
        caseId: created.case.id,
        toStageKey: "in_progress",
        expectedVersion: 1,
        actor: other,
      }),
    ).rejects.toMatchObject({ status: 409, details: { code: "lease_held" } });

    const transitioned = await svc.transitionCase({
      companyId: company.id,
      caseId: created.case.id,
      toStageKey: "in_progress",
      expectedVersion: 1,
      leaseToken: claimed.leaseToken,
      actor: owner,
    });
    expect(transitioned.case.version).toBe(2);
    expect(await eventCount(created.case.id)).toBe(3);
  });

  it("expires leases on read before a new claim", async () => {
    const { company, pipeline } = await seedPipeline();
    const created = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "expired-lease",
      title: "Expired lease",
      actor: userActor,
    });
    await db.update(pipelineCases).set({
      leaseOwnerType: "user",
      leaseUserId: "old-owner",
      leaseToken: randomUUID(),
      leaseExpiresAt: new Date(Date.now() - 5_000),
    }).where(eq(pipelineCases.id, created.case.id));

    const claimed = await svc.claimCase({ companyId: company.id, caseId: created.case.id, actor: { type: "user", userId: "new-owner" } });

    expect(claimed.leaseUserId).toBe("new-owner");
    const events = await svc.listCaseEvents(company.id, created.case.id);
    expect(events.map((event) => event.type)).toEqual(["ingested", "lease_expired", "claimed"]);
  });

  it("enforces transition edges only when enforceTransitions is enabled", async () => {
    const { company, pipeline } = await seedPipeline({ enforceTransitions: true });
    const created = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "edges",
      title: "Transition edges",
      actor: userActor,
    });

    await expect(
      svc.transitionCase({
        companyId: company.id,
        caseId: created.case.id,
        toStageKey: "done",
        expectedVersion: 1,
        actor: userActor,
      }),
    ).rejects.toMatchObject({ status: 409, details: { code: "transition_not_allowed" } });

    await db.update(pipelines).set({ enforceTransitions: false }).where(eq(pipelines.id, pipeline.id));
    const moved = await svc.transitionCase({
      companyId: company.id,
      caseId: created.case.id,
      toStageKey: "done",
      expectedVersion: 1,
      actor: userActor,
    });
    expect(moved.case.terminalKind).toBe("done");
  });

  it("blocks transitions while blockers are not done", async () => {
    const { company, pipeline } = await seedPipeline();
    const blocked = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "blocked",
      title: "Blocked case",
      actor: userActor,
    });
    const blocker = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "blocker",
      title: "Blocking case",
      actor: userActor,
    });
    await db.insert(pipelineCaseBlockers).values({
      companyId: company.id,
      caseId: blocked.case.id,
      blockedByCaseId: blocker.case.id,
    });

    await expect(
      svc.transitionCase({
        companyId: company.id,
        caseId: blocked.case.id,
        toStageKey: "in_progress",
        expectedVersion: 1,
        actor: userActor,
      }),
    ).rejects.toMatchObject({ status: 409, details: { code: "blocked" } });

    await svc.transitionCase({
      companyId: company.id,
      caseId: blocker.case.id,
      toStageKey: "done",
      expectedVersion: 1,
      actor: userActor,
    });
    const moved = await svc.transitionCase({
      companyId: company.id,
      caseId: blocked.case.id,
      toStageKey: "in_progress",
      expectedVersion: 1,
      actor: userActor,
    });
    expect(moved.case.version).toBe(2);
  });

  it("records suggestion supersede, accept, and dismiss lifecycles", async () => {
    const { company, pipeline } = await seedPipeline();
    const created = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "suggest-accept",
      title: "Suggestion accept",
      actor: userActor,
    });
    const first = await svc.suggestTransition({
      companyId: company.id,
      caseId: created.case.id,
      toStageKey: "review",
      rationale: "Needs review",
      actor: userActor,
    });
    const second = await svc.suggestTransition({
      companyId: company.id,
      caseId: created.case.id,
      toStageKey: "in_progress",
      rationale: "Actually draft first",
      actor: userActor,
    });
    expect(second.suggestion.id).not.toBe(first.suggestion.id);

    const accepted = await svc.resolveSuggestion({
      companyId: company.id,
      caseId: created.case.id,
      suggestionId: second.suggestion.id,
      decision: "accept",
      expectedVersion: 1,
      actor: userActor,
    });
    expect(accepted.case.version).toBe(2);
    const acceptEvents = await svc.listCaseEvents(company.id, created.case.id);
    expect(acceptEvents.map((event) => event.type)).toEqual([
      "ingested",
      "transition_suggested",
      "transition_suggested",
      "transitioned",
      "suggestion_resolved",
    ]);

    const dismissCase = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "suggest-dismiss",
      title: "Suggestion dismiss",
      actor: userActor,
    });
    const suggestion = await svc.suggestTransition({
      companyId: company.id,
      caseId: dismissCase.case.id,
      toStageKey: "review",
      rationale: "Maybe review",
      actor: userActor,
    });
    await svc.resolveSuggestion({
      companyId: company.id,
      caseId: dismissCase.case.id,
      suggestionId: suggestion.suggestion.id,
      decision: "dismiss",
      reason: "Not ready",
      actor: userActor,
    });
    const [dismissed] = await db.select().from(pipelineCases).where(eq(pipelineCases.id, dismissCase.case.id));
    expect(dismissed!.pendingSuggestion).toBeNull();
    expect(dismissed!.version).toBe(1);
  });

  it("writes an event for each case mutation and rejects agent mutations without run provenance", async () => {
    const { company, pipeline } = await seedPipeline();
    const agentActor = { type: "agent", agentId: randomUUID() } as PipelineActor;
    await expect(
      svc.ingestCase({
        companyId: company.id,
        pipelineId: pipeline.id,
        caseKey: "bad-agent",
        title: "Bad provenance",
        actor: agentActor,
      }),
    ).rejects.toMatchObject({ status: 422, details: { code: "run_id_required" } });

    const created = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "events",
      title: "Events",
      actor: userActor,
    });
    expect(await eventCount(created.case.id)).toBe(1);
    await svc.patchCaseContent({ companyId: company.id, caseId: created.case.id, title: "Updated", actor: userActor });
    expect(await eventCount(created.case.id)).toBe(2);
    const claimed = await svc.claimCase({ companyId: company.id, caseId: created.case.id, actor: { type: "user", userId: "claimer" } });
    expect(await eventCount(created.case.id)).toBe(3);
    await svc.releaseCase({ companyId: company.id, caseId: created.case.id, leaseToken: claimed.leaseToken, actor: { type: "user", userId: "claimer" } });
    expect(await eventCount(created.case.id)).toBe(4);
    await svc.transitionCase({
      companyId: company.id,
      caseId: created.case.id,
      toStageKey: "in_progress",
      expectedVersion: 2,
      actor: userActor,
    });
    expect(await eventCount(created.case.id)).toBe(5);
  });

  it("creates a stage-entry automation ledger idempotently with the transition event", async () => {
    const company = await seedCompany();
    const [agent] = await db.insert(agents).values({
      companyId: company.id,
      name: "Routine Agent",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    }).returning();
    const [routine] = await db.insert(routines).values({
      companyId: company.id,
      title: "Draft on enter",
      assigneeAgentId: agent!.id,
    }).returning();
    const pipeline = await svc.createPipeline({
      companyId: company.id,
      key: "automation",
      name: "Automation",
      actor: userActor,
      stages: [
        { key: "intake", name: "Intake", kind: "open" },
        { key: "drafting", name: "Drafting", kind: "working", config: { onEnter: { type: "run_routine", routineId: routine!.id } } },
        { key: "done", name: "Done", kind: "done" },
        { key: "cancelled", name: "Cancelled", kind: "cancelled" },
      ],
    });
    const created = await svc.ingestCase({
      companyId: company.id,
      pipelineId: pipeline.id,
      caseKey: "automation",
      title: "Automation case",
      actor: userActor,
    });

    const moved = await svc.transitionCase({
      companyId: company.id,
      caseId: created.case.id,
      toStageKey: "drafting",
      expectedVersion: 1,
      actor: userActor,
    });
    expect(moved.automationLedger?.routineId).toBe(routine!.id);
    const ledgers = await db.select().from(pipelineAutomationExecutions);
    expect(ledgers).toHaveLength(1);
    expect(ledgers[0]!.triggeringEventId).toBe(moved.event.id);
  });
});
