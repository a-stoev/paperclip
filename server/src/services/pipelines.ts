import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, ne, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  pipelineAutomationExecutions,
  pipelineCaseBlockers,
  pipelineCaseEvents,
  pipelineCases,
  pipelineStages,
  pipelineTransitions,
  pipelines,
} from "@paperclipai/db";
import { conflict, HttpError, notFound, unprocessable } from "../errors.js";

const DEFAULT_LEASE_MS = 15 * 60 * 1000;
const MAX_LEASE_MS = 24 * 60 * 60 * 1000;
const MAX_CASE_KEY_LENGTH = 1024;
const MAX_BATCH_INGEST = 200;
const MAX_FIELDS_BYTES = 64 * 1024;

const DEFAULT_STAGES = [
  { key: "intake", name: "Intake", kind: "open", position: 100 },
  { key: "in_progress", name: "In progress", kind: "working", position: 200 },
  { key: "review", name: "Review", kind: "review", position: 300 },
  { key: "done", name: "Done", kind: "done", position: 900 },
  { key: "cancelled", name: "Cancelled", kind: "cancelled", position: 1000 },
] as const;

export type PipelineActor =
  | { type: "user"; userId: string }
  | { type: "agent"; agentId: string; runId: string }
  | { type: "system" };

export type PipelineStageKind = "open" | "working" | "review" | "done" | "cancelled";

export type PipelineStageConfig = Record<string, unknown> & {
  autonomy?: "manual" | "suggest" | "auto";
  onEnter?: {
    type?: "run_routine";
    routineId?: string;
    id?: string;
  };
};

type PipelineDb = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

function nowDate() {
  return new Date();
}

function eventActorPatch(actor: PipelineActor) {
  if (actor.type === "agent") {
    assertActorProvenance(actor);
    return { actorType: "agent", actorAgentId: actor.agentId, runId: actor.runId };
  }
  if (actor.type === "user") {
    return { actorType: "user", actorUserId: actor.userId };
  }
  return { actorType: "system" };
}

function assertActorProvenance(actor: PipelineActor) {
  if (actor.type === "agent" && !actor.runId) {
    throw unprocessable("Agent pipeline mutations require a run id", { code: "run_id_required" });
  }
}

function assertCaseKey(caseKey: string) {
  if (caseKey.length > MAX_CASE_KEY_LENGTH) {
    throw unprocessable("caseKey must be at most 1024 characters", { code: "validation" });
  }
}

function assertJsonSize(value: unknown, label: string) {
  const bytes = Buffer.byteLength(JSON.stringify(value ?? {}), "utf8");
  if (bytes > MAX_FIELDS_BYTES) {
    throw unprocessable(`${label} must be at most 64KB`, { code: "validation" });
  }
}

function isTerminalKind(kind: string | null | undefined) {
  return kind === "done" || kind === "cancelled";
}

function terminalKindForStage(kind: string) {
  return isTerminalKind(kind) ? kind : null;
}

function hasValidLease(row: typeof pipelineCases.$inferSelect, now = nowDate()) {
  return Boolean(row.leaseToken && row.leaseExpiresAt && row.leaseExpiresAt.getTime() > now.getTime());
}

function leaseOwner(row: typeof pipelineCases.$inferSelect) {
  if (row.leaseOwnerType === "agent") {
    return { type: "agent", agentId: row.leaseAgentId, expiresAt: row.leaseExpiresAt };
  }
  if (row.leaseOwnerType === "user") {
    return { type: "user", userId: row.leaseUserId, expiresAt: row.leaseExpiresAt };
  }
  return { type: row.leaseOwnerType, expiresAt: row.leaseExpiresAt };
}

function actorOwnsLease(row: typeof pipelineCases.$inferSelect, actor: PipelineActor, leaseToken?: string | null) {
  if (!row.leaseToken) return true;
  if (leaseToken && leaseToken === row.leaseToken) return true;
  if (actor.type === "agent") return row.leaseOwnerType === "agent" && row.leaseAgentId === actor.agentId;
  if (actor.type === "user") return row.leaseOwnerType === "user" && row.leaseUserId === actor.userId;
  return false;
}

function conflictDetailsForCase(row: typeof pipelineCases.$inferSelect, stage?: typeof pipelineStages.$inferSelect | null) {
  return {
    code: "version_conflict",
    version: row.version,
    stage: stage ? { id: stage.id, key: stage.key, kind: stage.kind } : { id: row.stageId },
  };
}

function stageConfig(stage: typeof pipelineStages.$inferSelect): PipelineStageConfig {
  return (stage.config ?? {}) as PipelineStageConfig;
}

async function writeCaseEvent(
  db: PipelineDb,
  input: {
    companyId: string;
    caseId: string;
    type: string;
    actor: PipelineActor;
    fromStageId?: string | null;
    toStageId?: string | null;
    payload?: Record<string, unknown>;
  },
) {
  const [event] = await db
    .insert(pipelineCaseEvents)
    .values({
      companyId: input.companyId,
      caseId: input.caseId,
      type: input.type,
      ...eventActorPatch(input.actor),
      fromStageId: input.fromStageId ?? null,
      toStageId: input.toStageId ?? null,
      payload: input.payload ?? {},
    })
    .returning();
  return event!;
}

async function getPipelineOrThrow(db: PipelineDb, companyId: string, pipelineId: string) {
  const row = await db
    .select()
    .from(pipelines)
    .where(and(eq(pipelines.id, pipelineId), eq(pipelines.companyId, companyId)))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!row) throw notFound("Pipeline not found");
  return row;
}

async function getStageOrThrow(db: PipelineDb, pipelineId: string, stageId: string) {
  const row = await db
    .select()
    .from(pipelineStages)
    .where(and(eq(pipelineStages.id, stageId), eq(pipelineStages.pipelineId, pipelineId)))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!row) throw notFound("Pipeline stage not found");
  return row;
}

async function getStageByKeyOrThrow(db: PipelineDb, pipelineId: string, key: string) {
  const row = await db
    .select()
    .from(pipelineStages)
    .where(and(eq(pipelineStages.pipelineId, pipelineId), eq(pipelineStages.key, key)))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!row) throw notFound("Pipeline stage not found");
  return row;
}

async function getCaseWithStageOrThrow(db: PipelineDb, companyId: string, caseId: string) {
  const row = await db
    .select({ case: pipelineCases, stage: pipelineStages, pipeline: pipelines })
    .from(pipelineCases)
    .innerJoin(pipelineStages, eq(pipelineCases.stageId, pipelineStages.id))
    .innerJoin(pipelines, eq(pipelineCases.pipelineId, pipelines.id))
    .where(and(eq(pipelineCases.id, caseId), eq(pipelineCases.companyId, companyId), eq(pipelines.companyId, companyId)))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!row) throw notFound("Pipeline case not found");
  return row;
}

async function expireLeaseIfNeeded(db: PipelineDb, row: typeof pipelineCases.$inferSelect, actor: PipelineActor) {
  const now = nowDate();
  if (!row.leaseToken || !row.leaseExpiresAt || row.leaseExpiresAt.getTime() > now.getTime()) {
    return row;
  }

  const [updated] = await db
    .update(pipelineCases)
    .set({
      leaseOwnerType: null,
      leaseAgentId: null,
      leaseUserId: null,
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: now,
    })
    .where(and(eq(pipelineCases.id, row.id), eq(pipelineCases.leaseToken, row.leaseToken)))
    .returning();
  if (!updated) return row;

  await writeCaseEvent(db, {
    companyId: row.companyId,
    caseId: row.id,
    type: "lease_expired",
    actor,
    payload: { previousOwner: leaseOwner(row), expiredAt: now.toISOString() },
  });
  return updated;
}

async function assertLeaseAvailable(
  db: PipelineDb,
  row: typeof pipelineCases.$inferSelect,
  actor: PipelineActor,
  leaseToken?: string | null,
) {
  const current = await expireLeaseIfNeeded(db, row, { type: "system" });
  if (hasValidLease(current) && !actorOwnsLease(current, actor, leaseToken)) {
    throw conflict("Pipeline case lease is held", { code: "lease_held", lease: leaseOwner(current) });
  }
  return current;
}

async function assertNoOpenBlockers(db: PipelineDb, row: typeof pipelineCases.$inferSelect, toStage: typeof pipelineStages.$inferSelect) {
  if (toStage.kind === "cancelled") return;
  const blockers = await db
    .select({
      id: pipelineCases.id,
      caseKey: pipelineCases.caseKey,
      title: pipelineCases.title,
      terminalKind: pipelineCases.terminalKind,
    })
    .from(pipelineCaseBlockers)
    .innerJoin(pipelineCases, eq(pipelineCaseBlockers.blockedByCaseId, pipelineCases.id))
    .where(
      and(
        eq(pipelineCaseBlockers.companyId, row.companyId),
        eq(pipelineCaseBlockers.caseId, row.id),
        or(isNull(pipelineCases.terminalKind), ne(pipelineCases.terminalKind, "done")),
      ),
    );
  if (blockers.length > 0) {
    throw conflict("Pipeline case is blocked", { code: "blocked", blockers });
  }
}

async function enqueueStageAutomationLedger(
  db: PipelineDb,
  input: {
    companyId: string;
    caseId: string;
    stage: typeof pipelineStages.$inferSelect;
    eventId: string;
  },
) {
  const config = stageConfig(input.stage);
  const onEnter = config.onEnter;
  if (!onEnter || onEnter.type !== "run_routine" || !onEnter.routineId) return null;
  const automationId = onEnter.id ?? `${input.stage.id}:on_enter`;
  const [ledger] = await db
    .insert(pipelineAutomationExecutions)
    .values({
      companyId: input.companyId,
      caseId: input.caseId,
      automationId,
      triggeringEventId: input.eventId,
      routineId: onEnter.routineId,
      status: "succeeded",
    })
    .onConflictDoNothing({
      target: [
        pipelineAutomationExecutions.caseId,
        pipelineAutomationExecutions.automationId,
        pipelineAutomationExecutions.triggeringEventId,
      ],
    })
    .returning();
  return ledger ?? null;
}

export function pipelineService(db: Db) {
  async function transitionCaseInTransaction(
    tx: PipelineDb,
    input: {
      companyId: string;
      caseId: string;
      toStageId?: string;
      toStageKey?: string;
      expectedVersion: number;
      leaseToken?: string | null;
      actor: PipelineActor;
      transitionClass?: "manual" | "suggested" | "auto";
      suggestionId?: string;
      reason?: string | null;
    },
  ) {
    if (input.transitionClass === "auto") {
      throw unprocessable("Pipeline auto autonomy is not enabled", { code: "autonomy_not_enabled" });
    }
    const { case: existing, stage: fromStage, pipeline } = await getCaseWithStageOrThrow(tx, input.companyId, input.caseId);
    if (pipeline.archivedAt) throw unprocessable("Pipeline is archived", { code: "pipeline_archived" });
    const current = await assertLeaseAvailable(tx, existing, input.actor, input.leaseToken);
    if (current.version !== input.expectedVersion) {
      throw conflict("Pipeline case version conflict", conflictDetailsForCase(current, fromStage));
    }
    if (fromStage.kind === "review" && input.actor.type === "agent") {
      const config = stageConfig(fromStage);
      if (config.reviewerKind !== "any") {
        throw new HttpError(403, "Human review is required", { code: "review_required" });
      }
    }

    const toStage = input.toStageId
      ? await getStageOrThrow(tx, current.pipelineId, input.toStageId)
      : await getStageByKeyOrThrow(tx, current.pipelineId, input.toStageKey ?? "");
    const toConfig = stageConfig(toStage);
    if (toConfig.autonomy === "auto") {
      throw unprocessable("Pipeline auto autonomy is not enabled", { code: "autonomy_not_enabled" });
    }
    if (pipeline.enforceTransitions && fromStage.id !== toStage.id) {
      const allowed = await tx
        .select({ id: pipelineTransitions.id })
        .from(pipelineTransitions)
        .where(
          and(
            eq(pipelineTransitions.pipelineId, current.pipelineId),
            eq(pipelineTransitions.fromStageId, fromStage.id),
            eq(pipelineTransitions.toStageId, toStage.id),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!allowed) {
        throw conflict("Pipeline transition is not allowed", { code: "transition_not_allowed" });
      }
    }
    await assertNoOpenBlockers(tx, current, toStage);

    const enteringTerminal = terminalKindForStage(toStage.kind);
    const [updated] = await tx
      .update(pipelineCases)
      .set({
        stageId: toStage.id,
        version: current.version + 1,
        terminalKind: enteringTerminal,
        terminalAt: enteringTerminal ? nowDate() : null,
        pendingSuggestion: input.suggestionId === current.pendingSuggestion?.id ? null : current.pendingSuggestion,
        leaseOwnerType: enteringTerminal ? null : current.leaseOwnerType,
        leaseAgentId: enteringTerminal ? null : current.leaseAgentId,
        leaseUserId: enteringTerminal ? null : current.leaseUserId,
        leaseToken: enteringTerminal ? null : current.leaseToken,
        leaseExpiresAt: enteringTerminal ? null : current.leaseExpiresAt,
        updatedAt: nowDate(),
      })
      .where(and(eq(pipelineCases.id, current.id), eq(pipelineCases.version, current.version)))
      .returning();
    if (!updated) {
      const latest = await getCaseWithStageOrThrow(tx, input.companyId, input.caseId);
      throw conflict("Pipeline case version conflict", conflictDetailsForCase(latest.case, latest.stage));
    }

    const event = await writeCaseEvent(tx, {
      companyId: input.companyId,
      caseId: current.id,
      type: "transitioned",
      actor: input.actor,
      fromStageId: fromStage.id,
      toStageId: toStage.id,
      payload: {
        previousVersion: current.version,
        version: updated.version,
        suggestionId: input.suggestionId ?? null,
        reason: input.reason ?? null,
        transitionClass: input.transitionClass ?? "manual",
      },
    });
    const ledger = await enqueueStageAutomationLedger(tx, {
      companyId: input.companyId,
      caseId: current.id,
      stage: toStage,
      eventId: event.id,
    });
    return { case: updated, event, automationLedger: ledger };
  }

  const service = {
    async createPipeline(input: {
      companyId: string;
      key: string;
      name: string;
      description?: string | null;
      projectId?: string | null;
      enforceTransitions?: boolean;
      stages?: Array<{ key: string; name: string; kind: PipelineStageKind; position?: number; config?: PipelineStageConfig }>;
      actor: PipelineActor;
    }) {
      return db.transaction(async (tx) => {
        const [pipeline] = await tx
          .insert(pipelines)
          .values({
            companyId: input.companyId,
            key: input.key,
            name: input.name,
            description: input.description ?? null,
            projectId: input.projectId ?? null,
            enforceTransitions: input.enforceTransitions ?? false,
            createdByUserId: input.actor.type === "user" ? input.actor.userId : null,
            createdByAgentId: input.actor.type === "agent" ? input.actor.agentId : null,
          })
          .returning();
        const stageInputs = input.stages?.length
          ? input.stages.map((stage, index) => ({ ...stage, position: stage.position ?? (index + 1) * 100 }))
          : DEFAULT_STAGES.map((stage) => ({ ...stage, config: {} }));
        const insertedStages = await tx
          .insert(pipelineStages)
          .values(stageInputs.map((stage) => ({
            pipelineId: pipeline!.id,
            key: stage.key,
            name: stage.name,
            kind: stage.kind,
            position: stage.position,
            config: stage.config ?? {},
          })))
          .returning();

        if (!insertedStages.some((stage) => stage.kind === "done") || !insertedStages.some((stage) => stage.kind === "cancelled")) {
          throw unprocessable("Pipeline must include at least one done stage and one cancelled stage", { code: "validation" });
        }

        if (!input.stages?.length) {
          const byKey = new Map(insertedStages.map((stage) => [stage.key, stage]));
          const edges = [
            ["intake", "in_progress"],
            ["in_progress", "review"],
            ["review", "done"],
          ] as const;
          await tx.insert(pipelineTransitions).values(edges.map(([from, to]) => ({
            pipelineId: pipeline!.id,
            fromStageId: byKey.get(from)!.id,
            toStageId: byKey.get(to)!.id,
          })));
        }

        return { ...pipeline!, stages: insertedStages };
      });
    },

    async listStages(companyId: string, pipelineId: string) {
      await getPipelineOrThrow(db, companyId, pipelineId);
      return db
        .select()
        .from(pipelineStages)
        .where(eq(pipelineStages.pipelineId, pipelineId))
        .orderBy(asc(pipelineStages.position), asc(pipelineStages.createdAt));
    },

    async createStage(input: {
      companyId: string;
      pipelineId: string;
      key: string;
      name: string;
      kind: PipelineStageKind;
      position: number;
      config?: PipelineStageConfig;
    }) {
      await getPipelineOrThrow(db, input.companyId, input.pipelineId);
      const [stage] = await db
        .insert(pipelineStages)
        .values({
          pipelineId: input.pipelineId,
          key: input.key,
          name: input.name,
          kind: input.kind,
          position: input.position,
          config: input.config ?? {},
        })
        .returning();
      return stage!;
    },

    async deleteStage(input: {
      companyId: string;
      pipelineId: string;
      stageId: string;
      moveCasesToStageId?: string | null;
      actor?: PipelineActor;
    }) {
      return db.transaction(async (tx) => {
        await getPipelineOrThrow(tx, input.companyId, input.pipelineId);
        const stage = await getStageOrThrow(tx, input.pipelineId, input.stageId);
        const targetStage = input.moveCasesToStageId
          ? await getStageOrThrow(tx, input.pipelineId, input.moveCasesToStageId)
          : null;
        const casesInStage = await tx
          .select()
          .from(pipelineCases)
          .where(and(eq(pipelineCases.pipelineId, input.pipelineId), eq(pipelineCases.stageId, stage.id)));
        if (casesInStage.length > 0 && !targetStage) {
          throw unprocessable("Cannot delete a stage that holds cases without moveCasesToStageId", { code: "stage_has_cases" });
        }
        if (targetStage) {
          const movedCases = await tx
            .update(pipelineCases)
            .set({
              stageId: targetStage.id,
              version: sql`${pipelineCases.version} + 1`,
              terminalKind: terminalKindForStage(targetStage.kind),
              terminalAt: isTerminalKind(targetStage.kind) ? nowDate() : null,
              updatedAt: nowDate(),
            })
            .where(and(eq(pipelineCases.pipelineId, input.pipelineId), eq(pipelineCases.stageId, stage.id)))
            .returning();
          for (const movedCase of movedCases) {
            const previous = casesInStage.find((row) => row.id === movedCase.id);
            await writeCaseEvent(tx, {
              companyId: input.companyId,
              caseId: movedCase.id,
              type: "transitioned",
              actor: input.actor ?? { type: "system" },
              fromStageId: stage.id,
              toStageId: targetStage.id,
              payload: {
                reason: "stage_deleted",
                previousVersion: previous?.version ?? movedCase.version - 1,
                version: movedCase.version,
              },
            });
          }
        }
        await tx.delete(pipelineTransitions).where(or(eq(pipelineTransitions.fromStageId, stage.id), eq(pipelineTransitions.toStageId, stage.id)));
        await tx.delete(pipelineStages).where(eq(pipelineStages.id, stage.id));
        return { deleted: true };
      });
    },

    async createTransition(input: { companyId: string; pipelineId: string; fromStageId: string; toStageId: string; label?: string | null }) {
      await getPipelineOrThrow(db, input.companyId, input.pipelineId);
      await getStageOrThrow(db, input.pipelineId, input.fromStageId);
      await getStageOrThrow(db, input.pipelineId, input.toStageId);
      const [transition] = await db
        .insert(pipelineTransitions)
        .values({
          pipelineId: input.pipelineId,
          fromStageId: input.fromStageId,
          toStageId: input.toStageId,
          label: input.label ?? null,
        })
        .returning();
      return transition!;
    },

    async ingestCase(input: {
      companyId: string;
      pipelineId: string;
      caseKey?: string | null;
      title: string;
      summary?: string | null;
      fields?: Record<string, unknown>;
      stageKey?: string | null;
      parentCaseId?: string | null;
      actor: PipelineActor;
    }) {
      assertJsonSize(input.fields ?? {}, "fields");
      assertActorProvenance(input.actor);
      const caseKey = input.caseKey ?? randomUUID();
      assertCaseKey(caseKey);

      return db.transaction(async (tx) => {
        const pipeline = await getPipelineOrThrow(tx, input.companyId, input.pipelineId);
        if (pipeline.archivedAt) throw unprocessable("Pipeline is archived", { code: "pipeline_archived" });
        const stage = input.stageKey
          ? await getStageByKeyOrThrow(tx, input.pipelineId, input.stageKey)
          : await tx
            .select()
            .from(pipelineStages)
            .where(eq(pipelineStages.pipelineId, input.pipelineId))
            .orderBy(asc(pipelineStages.position), asc(pipelineStages.createdAt))
            .limit(1)
            .then((rows) => rows[0] ?? null);
        if (!stage) throw unprocessable("Pipeline has no stages", { code: "validation" });

        const [inserted] = await tx
          .insert(pipelineCases)
          .values({
            companyId: input.companyId,
            pipelineId: input.pipelineId,
            stageId: stage.id,
            caseKey,
            title: input.title,
            summary: input.summary ?? null,
            fields: input.fields ?? {},
            parentCaseId: input.parentCaseId ?? null,
            terminalKind: terminalKindForStage(stage.kind),
            terminalAt: isTerminalKind(stage.kind) ? nowDate() : null,
            createdByUserId: input.actor.type === "user" ? input.actor.userId : null,
            createdByAgentId: input.actor.type === "agent" ? input.actor.agentId : null,
            originRunId: input.actor.type === "agent" ? input.actor.runId : null,
          })
          .onConflictDoNothing({ target: [pipelineCases.pipelineId, pipelineCases.caseKey] })
          .returning();

        if (!inserted) {
          const existing = await tx
            .select()
            .from(pipelineCases)
            .where(and(eq(pipelineCases.pipelineId, input.pipelineId), eq(pipelineCases.caseKey, caseKey)))
            .limit(1)
            .then((rows) => rows[0] ?? null);
          if (!existing) throw conflict("Pipeline case ingest conflict", { code: "ingest_conflict" });
          return { case: existing, created: false };
        }

        await writeCaseEvent(tx, {
          companyId: input.companyId,
          caseId: inserted.id,
          type: "ingested",
          actor: input.actor,
          toStageId: stage.id,
          payload: { caseKey },
        });
        return { case: inserted, created: true };
      });
    },

    async ingestCases(input: {
      companyId: string;
      pipelineId: string;
      items: Array<{
        caseKey?: string | null;
        title: string;
        summary?: string | null;
        fields?: Record<string, unknown>;
        stageKey?: string | null;
        parentCaseId?: string | null;
      }>;
      actor: PipelineActor;
    }) {
      if (input.items.length > MAX_BATCH_INGEST) {
        throw unprocessable("Batch ingest supports at most 200 items", { code: "validation" });
      }
      const seen = new Set<string>();
      return Promise.all(input.items.map(async (item) => {
        const key = item.caseKey ?? null;
        if (key) {
          if (seen.has(key)) {
            return { ok: false as const, caseKey: key, error: { code: "duplicate_batch_key" } };
          }
          seen.add(key);
        }
        try {
          const result = await service.ingestCase({
            ...item,
            companyId: input.companyId,
            pipelineId: input.pipelineId,
            actor: input.actor,
          });
          return { ok: true as const, ...result };
        } catch (error) {
          const httpError = error as { status?: number; message?: string; details?: unknown };
          return {
            ok: false as const,
            caseKey: key,
            error: { status: httpError.status ?? 500, message: httpError.message ?? "Unknown error", details: httpError.details },
          };
        }
      }));
    },

    async patchCaseContent(input: {
      companyId: string;
      caseId: string;
      title?: string;
      summary?: string | null;
      fields?: Record<string, unknown>;
      expectedVersion?: number;
      leaseToken?: string | null;
      actor: PipelineActor;
    }) {
      if (input.fields !== undefined) assertJsonSize(input.fields, "fields");
      return db.transaction(async (tx) => {
        const { case: existing, stage } = await getCaseWithStageOrThrow(tx, input.companyId, input.caseId);
        const current = await assertLeaseAvailable(tx, existing, input.actor, input.leaseToken);
        if (input.expectedVersion !== undefined && current.version !== input.expectedVersion) {
          throw conflict("Pipeline case version conflict", conflictDetailsForCase(current, stage));
        }
        const patch: Partial<typeof pipelineCases.$inferInsert> = {
          version: current.version + 1,
          updatedAt: nowDate(),
        };
        if (input.title !== undefined) patch.title = input.title;
        if (input.summary !== undefined) patch.summary = input.summary;
        if (input.fields !== undefined) patch.fields = input.fields;

        const [updated] = await tx
          .update(pipelineCases)
          .set(patch)
          .where(and(eq(pipelineCases.id, current.id), eq(pipelineCases.version, current.version)))
          .returning();
        if (!updated) {
          const latest = await getCaseWithStageOrThrow(tx, input.companyId, input.caseId);
          throw conflict("Pipeline case version conflict", conflictDetailsForCase(latest.case, latest.stage));
        }

        await writeCaseEvent(tx, {
          companyId: input.companyId,
          caseId: updated.id,
          type: "updated",
          actor: input.actor,
          payload: { previousVersion: current.version, version: updated.version },
        });
        return updated;
      });
    },

    async claimCase(input: {
      companyId: string;
      caseId: string;
      actor: Extract<PipelineActor, { type: "user" | "agent" }>;
      leaseMs?: number;
    }) {
      return db.transaction(async (tx) => {
        const { case: existing } = await getCaseWithStageOrThrow(tx, input.companyId, input.caseId);
        const current = await expireLeaseIfNeeded(tx, existing, { type: "system" });
        if (hasValidLease(current) && !actorOwnsLease(current, input.actor, null)) {
          throw conflict("Pipeline case lease is held", { code: "lease_held", lease: leaseOwner(current) });
        }
        const leaseMs = Math.min(Math.max(input.leaseMs ?? DEFAULT_LEASE_MS, 1_000), MAX_LEASE_MS);
        const token = randomUUID();
        const expiresAt = new Date(Date.now() + leaseMs);
        const [updated] = await tx
          .update(pipelineCases)
          .set({
            leaseOwnerType: input.actor.type,
            leaseAgentId: input.actor.type === "agent" ? input.actor.agentId : null,
            leaseUserId: input.actor.type === "user" ? input.actor.userId : null,
            leaseToken: token,
            leaseExpiresAt: expiresAt,
            updatedAt: nowDate(),
          })
          .where(eq(pipelineCases.id, current.id))
          .returning();
        await writeCaseEvent(tx, {
          companyId: input.companyId,
          caseId: current.id,
          type: "claimed",
          actor: input.actor,
          payload: { leaseToken: token, leaseExpiresAt: expiresAt.toISOString() },
        });
        return updated!;
      });
    },

    async releaseCase(input: {
      companyId: string;
      caseId: string;
      actor: PipelineActor;
      leaseToken?: string | null;
      force?: boolean;
    }) {
      return db.transaction(async (tx) => {
        const { case: existing } = await getCaseWithStageOrThrow(tx, input.companyId, input.caseId);
        const current = await expireLeaseIfNeeded(tx, existing, { type: "system" });
        if (!input.force && hasValidLease(current) && !actorOwnsLease(current, input.actor, input.leaseToken)) {
          throw conflict("Pipeline case lease is held", { code: "lease_held", lease: leaseOwner(current) });
        }
        const [updated] = await tx
          .update(pipelineCases)
          .set({
            leaseOwnerType: null,
            leaseAgentId: null,
            leaseUserId: null,
            leaseToken: null,
            leaseExpiresAt: null,
            updatedAt: nowDate(),
          })
          .where(eq(pipelineCases.id, current.id))
          .returning();
        await writeCaseEvent(tx, {
          companyId: input.companyId,
          caseId: current.id,
          type: "lease_released",
          actor: input.actor,
          payload: { forced: input.force === true },
        });
        return updated!;
      });
    },

    async transitionCase(input: {
      companyId: string;
      caseId: string;
      toStageId?: string;
      toStageKey?: string;
      expectedVersion: number;
      leaseToken?: string | null;
      actor: PipelineActor;
      transitionClass?: "manual" | "suggested" | "auto";
      suggestionId?: string;
      reason?: string | null;
    }) {
      return db.transaction((tx) => transitionCaseInTransaction(tx, input));
    },

    async suggestTransition(input: {
      companyId: string;
      caseId: string;
      toStageKey: string;
      rationale: string;
      confidence?: number;
      actor: PipelineActor;
    }) {
      return db.transaction(async (tx) => {
        const { case: existing } = await getCaseWithStageOrThrow(tx, input.companyId, input.caseId);
        await getStageByKeyOrThrow(tx, existing.pipelineId, input.toStageKey);
        const suggestion = {
          id: randomUUID(),
          toStageKey: input.toStageKey,
          rationale: input.rationale,
          confidence: input.confidence,
          suggestedByAgentId: input.actor.type === "agent" ? input.actor.agentId : undefined,
          runId: input.actor.type === "agent" ? input.actor.runId : undefined,
          createdAt: nowDate().toISOString(),
        };
        const superseded = existing.pendingSuggestion ?? null;
        const [updated] = await tx
          .update(pipelineCases)
          .set({ pendingSuggestion: suggestion, updatedAt: nowDate() })
          .where(eq(pipelineCases.id, existing.id))
          .returning();
        await writeCaseEvent(tx, {
          companyId: input.companyId,
          caseId: existing.id,
          type: "transition_suggested",
          actor: input.actor,
          payload: { suggestion, supersededSuggestionId: superseded?.id ?? null },
        });
        return { case: updated!, suggestion };
      });
    },

    async resolveSuggestion(input: {
      companyId: string;
      caseId: string;
      suggestionId: string;
      decision: "accept" | "dismiss";
      expectedVersion?: number;
      actor: PipelineActor;
      reason?: string | null;
      leaseToken?: string | null;
    }) {
      return db.transaction(async (tx) => {
        const { case: existing } = await getCaseWithStageOrThrow(tx, input.companyId, input.caseId);
        const suggestion = existing.pendingSuggestion;
        if (!suggestion || suggestion.id !== input.suggestionId) {
          throw conflict("Pipeline suggestion is not pending", { code: "suggestion_not_pending" });
        }
        if (input.decision === "dismiss") {
          const [updated] = await tx
            .update(pipelineCases)
            .set({ pendingSuggestion: null, updatedAt: nowDate() })
            .where(eq(pipelineCases.id, existing.id))
            .returning();
          const event = await writeCaseEvent(tx, {
            companyId: input.companyId,
            caseId: existing.id,
            type: "suggestion_resolved",
            actor: input.actor,
            payload: { suggestionId: input.suggestionId, decision: "dismiss", reason: input.reason ?? null },
          });
          return { case: updated!, event };
        }

        const transition = await transitionCaseInTransaction(tx, {
          companyId: input.companyId,
          caseId: input.caseId,
          toStageKey: suggestion.toStageKey,
          expectedVersion: input.expectedVersion ?? existing.version,
          actor: input.actor,
          leaseToken: input.leaseToken,
          transitionClass: "suggested",
          suggestionId: input.suggestionId,
          reason: input.reason,
        });
        await writeCaseEvent(tx, {
          companyId: input.companyId,
          caseId: existing.id,
          type: "suggestion_resolved",
          actor: input.actor,
          payload: { suggestionId: input.suggestionId, decision: "accept", reason: input.reason ?? null },
        });
        return transition;
      });
    },

    async listCaseEvents(companyId: string, caseId: string) {
      await getCaseWithStageOrThrow(db, companyId, caseId);
      return db
        .select()
        .from(pipelineCaseEvents)
        .where(and(eq(pipelineCaseEvents.companyId, companyId), eq(pipelineCaseEvents.caseId, caseId)))
        .orderBy(asc(pipelineCaseEvents.createdAt));
    },
  };

  return service;
}
