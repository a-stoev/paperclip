import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  documents,
  documentRevisions,
  heartbeatRuns,
  issueComments,
  issues,
  pipelineAutomationExecutions,
  pipelineCaseBlockers,
  pipelineCaseEvents,
  pipelineCaseIssueLinks,
  pipelineCases,
  pipelineDocuments,
  pipelineStages,
  pipelineTransitions,
  pipelines,
  routineRuns,
  routines,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/error-handler.js";
import { issueRoutes } from "../routes/issues.js";
import { pipelineRoutes } from "../routes/pipelines.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres pipeline route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("pipeline routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const noopHeartbeat = { wakeup: async () => null };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pipelines-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(pipelineAutomationExecutions);
    await db.delete(pipelineCaseBlockers);
    await db.delete(pipelineCaseIssueLinks);
    await db.delete(pipelineCaseEvents);
    await db.delete(pipelineCases);
    await db.delete(pipelineTransitions);
    await db.delete(pipelineStages);
    await db.delete(pipelineDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issueComments);
    await db.delete(routineRuns);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(pipelines);
    await db.delete(routines);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function app(actor: Express.Request["actor"]) {
    const instance = express();
    instance.use(express.json());
    instance.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    instance.use("/api", pipelineRoutes(db, { heartbeat: noopHeartbeat }));
    instance.use("/api", issueRoutes(db, {} as any));
    instance.use(errorHandler);
    return instance;
  }

  async function seedCompany(name = "Pipeline Co") {
    const [company] = await db.insert(companies).values({
      name,
      issuePrefix: `P${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    }).returning();
    return company!;
  }

  const boardActor: Express.Request["actor"] = {
    type: "board",
    userId: "board-user",
    source: "local_implicit",
    isInstanceAdmin: true,
  };

  it("exposes the pipeline and case route surface", async () => {
    const company = await seedCompany();
    const http = request(app(boardActor));

    const createdPipeline = await http
      .post(`/api/companies/${company.id}/pipelines`)
      .send({
        key: "content",
        name: "Content",
        stages: [
          { key: "intake", name: "Intake", kind: "open", position: 100 },
          {
            key: "review",
            name: "Review",
            kind: "review",
            position: 200,
            config: { approveToStageKey: "done", rejectToStageKey: "cancelled", requireRejectReason: true },
          },
          { key: "done", name: "Done", kind: "done", position: 900 },
          { key: "cancelled", name: "Cancelled", kind: "cancelled", position: 1000 },
        ],
      })
      .expect(201);
    const pipelineId = createdPipeline.body.id;
    const stageId = createdPipeline.body.stages[0].id;

    await http.get(`/api/companies/${company.id}/pipelines`).expect(200);
    await http.get(`/api/pipelines/${pipelineId}`).expect(200);
    await http.patch(`/api/pipelines/${pipelineId}`).send({ name: "Content Ops", enforceTransitions: true }).expect(200);
    const qaStage = await http
      .post(`/api/pipelines/${pipelineId}/stages`)
      .send({ key: "qa", name: "QA", kind: "working", position: 300 })
      .expect(201);
    await http.patch(`/api/pipelines/${pipelineId}/stages/${qaStage.body.id}`).send({ name: "QA pass" }).expect(200);
    await http
      .put(`/api/pipelines/${pipelineId}/transitions`)
      .send({ enforceTransitions: false, transitions: [{ fromStageKey: "intake", toStageKey: "review" }] })
      .expect(200);
    await http.put(`/api/pipelines/${pipelineId}/documents/guidance`).send({ body: "Use the rubric." }).expect(200);
    await http.get(`/api/pipelines/${pipelineId}/documents/guidance`).expect(200);

    const ingested = await http
      .post(`/api/pipelines/${pipelineId}/cases`)
      .send({ caseKey: "case-1", title: "Case 1", fields: { channel: "blog" } })
      .expect(201);
    const caseId = ingested.body.case.id;
    await http
      .post(`/api/pipelines/${pipelineId}/cases/batch`)
      .send({ items: [{ caseKey: "case-2", title: "Case 2" }, { caseKey: "case-3", title: "Case 3" }] })
      .expect(200);
    await http.get(`/api/pipelines/${pipelineId}/cases`).expect(200);
    await http.get(`/api/cases/${caseId}`).expect(200);
    await http.patch(`/api/cases/${caseId}`).send({ title: "Case 1 updated", expectedVersion: 1 }).expect(200);
    const claimed = await http.post(`/api/cases/${caseId}/claim`).send({ leaseSeconds: 60 }).expect(200);
    await http.post(`/api/cases/${caseId}/release`).send({ leaseToken: claimed.body.leaseToken }).expect(200);
    const suggestion = await http
      .post(`/api/cases/${caseId}/suggest-transition`)
      .send({ toStageKey: "review", rationale: "Ready for review" })
      .expect(200);
    await http
      .post(`/api/cases/${caseId}/resolve-suggestion`)
      .send({ suggestionId: suggestion.body.suggestion.id, resolution: "accept", expectedVersion: 2 })
      .expect(200);
    await http.get(`/api/cases/${caseId}/events`).expect(200);
    await http.get(`/api/companies/${company.id}/review-cases`).expect(200);
    await http.post(`/api/cases/${caseId}/review`).send({ decision: "approve", expectedVersion: 3 }).expect(200);

    const reviewCase = await http
      .post(`/api/pipelines/${pipelineId}/cases`)
      .send({ caseKey: "case-review", title: "Bulk review" })
      .expect(201);
    await http
      .post(`/api/cases/${reviewCase.body.case.id}/transition`)
      .send({ toStageKey: "review", expectedVersion: 1 })
      .expect(200);
    await http
      .post(`/api/companies/${company.id}/review-cases/bulk`)
      .send({ items: [{ caseId: reviewCase.body.case.id, decision: "reject", reason: "Not useful", expectedVersion: 2 }] })
      .expect(200);

    const blocker = await http.post(`/api/pipelines/${pipelineId}/cases`).send({ caseKey: "blocker", title: "Blocker" }).expect(201);
    const blocked = await http.post(`/api/pipelines/${pipelineId}/cases`).send({ caseKey: "blocked", title: "Blocked" }).expect(201);
    await http
      .put(`/api/cases/${blocked.body.case.id}/blockers`)
      .send({ blockedByCaseIds: [blocker.body.case.id] })
      .expect(200);
    await http.get(`/api/cases/${blocked.body.case.id}/rollup`).expect(200);
    await http.get(`/api/cases/${blocked.body.case.id}/context-pack`).expect(200);
    const conversation = await http.post(`/api/cases/${blocked.body.case.id}/open-conversation`).expect(201);
    expect(conversation.body.created).toBe(true);
    expect(conversation.body.issue.description).toContain("Pipeline Case Context");
    const sameConversation = await http.post(`/api/cases/${blocked.body.case.id}/open-conversation`).expect(200);
    expect(sameConversation.body.created).toBe(false);
    expect(sameConversation.body.issue.id).toBe(conversation.body.issue.id);

    const linkedIssue = await http.post(`/api/cases/${blocked.body.case.id}/issue-links`)
      .send({ issueId: ingested.body.case.id, role: "work" });
    expect(linkedIssue.status).toBe(404);
    const manualIssue = await db.insert(issues).values({
      companyId: company.id,
      title: "Manual work issue",
      status: "todo",
      priority: "medium",
    }).returning();
    const workLink = await http.post(`/api/cases/${blocked.body.case.id}/issue-links`)
      .send({ issueId: manualIssue[0]!.id, role: "work" })
      .expect(201);
    await http.get(`/api/cases/${blocked.body.case.id}/issue-links`).expect(200);
    const issueDetail = await http.get(`/api/issues/${manualIssue[0]!.id}`).expect(200);
    expect(issueDetail.body.linkedCases).toHaveLength(1);
    expect(issueDetail.body.linkedCases[0].id).toBe(blocked.body.case.id);
    await http.delete(`/api/cases/${blocked.body.case.id}/issue-links/${workLink.body.id}`).expect(200);

    const [routine] = await db.insert(routines).values({ companyId: company.id, title: "Routine" }).returning();
    await db.insert(pipelineAutomationExecutions).values({
      companyId: company.id,
      caseId: blocked.body.case.id,
      automationId: "retry-me",
      triggeringEventId: randomUUID(),
      routineId: routine!.id,
      status: "failed",
      error: "boom",
    });
    await http.post(`/api/cases/${blocked.body.case.id}/automations/retry-me/retry`).expect(200);

    await http.delete(`/api/pipelines/${pipelineId}/stages/${stageId}?moveCasesToStageId=${qaStage.body.id}`).expect(200);
  });

  it("returns 404 for cross-company pipeline access", async () => {
    const company = await seedCompany();
    const [pipeline] = await db.insert(pipelines).values({ companyId: company.id, key: "x", name: "X" }).returning();
    const otherAgent: Express.Request["actor"] = {
      type: "agent",
      agentId: randomUUID(),
      companyId: randomUUID(),
      runId: randomUUID(),
      source: "agent_key",
    };

    const res = await request(app(otherAgent)).get(`/api/pipelines/${pipeline!.id}`);
    expect(res.status).toBe(404);
  });

  it("rejects agent mutations without a run id", async () => {
    const company = await seedCompany();
    const agentActor: Express.Request["actor"] = {
      type: "agent",
      agentId: randomUUID(),
      companyId: company.id,
      source: "agent_key",
    };

    const res = await request(app(agentActor))
      .post(`/api/companies/${company.id}/pipelines`)
      .send({ key: "agent", name: "Agent pipeline" });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("run_id_required");
  });

  it("rejects agent exits from human review stages", async () => {
    const company = await seedCompany();
    const http = request(app(boardActor));
    const pipelineRes = await http
      .post(`/api/companies/${company.id}/pipelines`)
      .send({
        key: "review-authz",
        name: "Review authz",
        stages: [
          { key: "intake", name: "Intake", kind: "open", position: 100 },
          { key: "review", name: "Review", kind: "review", position: 200, config: { approveToStageKey: "done", rejectToStageKey: "cancelled" } },
          { key: "done", name: "Done", kind: "done", position: 900 },
          { key: "cancelled", name: "Cancelled", kind: "cancelled", position: 1000 },
        ],
      })
      .expect(201);
    const caseRes = await http.post(`/api/pipelines/${pipelineRes.body.id}/cases`).send({ caseKey: "review", title: "Review me" }).expect(201);
    await http.post(`/api/cases/${caseRes.body.case.id}/transition`).send({ toStageKey: "review", expectedVersion: 1 }).expect(200);

    const agentActor: Express.Request["actor"] = {
      type: "agent",
      agentId: randomUUID(),
      companyId: company.id,
      runId: randomUUID(),
      source: "agent_key",
    };
    const res = await request(app(agentActor))
      .post(`/api/cases/${caseRes.body.case.id}/transition`)
      .send({ toStageKey: "done", expectedVersion: 2 });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("review_required");
  });

  it("validates review stage config on create and update", async () => {
    const company = await seedCompany();
    const http = request(app(boardActor));

    await http
      .post(`/api/companies/${company.id}/pipelines`)
      .send({
        key: "bad-review",
        name: "Bad review",
        stages: [
          { key: "intake", name: "Intake", kind: "open", position: 100 },
          { key: "review", name: "Review", kind: "review", position: 200 },
          { key: "done", name: "Done", kind: "done", position: 900 },
          { key: "cancelled", name: "Cancelled", kind: "cancelled", position: 1000 },
        ],
      })
      .expect(422);

    const pipeline = await http.post(`/api/companies/${company.id}/pipelines`).send({ key: "valid-review", name: "Valid review" }).expect(201);
    const intake = pipeline.body.stages.find((stage: { key: string }) => stage.key === "intake");
    await http.patch(`/api/pipelines/${pipeline.body.id}/stages/${intake.id}`).send({ kind: "review" }).expect(422);
  });

  it("applies review decisions atomically with edits and stores reject reasons verbatim", async () => {
    const company = await seedCompany();
    const http = request(app(boardActor));
    const pipeline = await http.post(`/api/companies/${company.id}/pipelines`).send({ key: "review-decisions", name: "Review decisions" }).expect(201);

    const approved = await http
      .post(`/api/pipelines/${pipeline.body.id}/cases`)
      .send({ caseKey: "approve-edit", title: "Approve edit" })
      .expect(201);
    await http.post(`/api/cases/${approved.body.case.id}/transition`).send({ toStageKey: "review", expectedVersion: 1 }).expect(200);
    const approval = await http
      .post(`/api/cases/${approved.body.case.id}/review`)
      .send({
        decision: "approve",
        expectedVersion: 2,
        edits: { title: "Approved title", fields: { channel: "blog" } },
      })
      .expect(200);
    expect(approval.body.case.version).toBe(4);
    expect(approval.body.updateEvent.payload.version).toBe(3);
    const approvedDetail = await http.get(`/api/cases/${approved.body.case.id}`).expect(200);
    expect(approvedDetail.body.case.title).toBe("Approved title");
    expect(approvedDetail.body.case.fields).toEqual({ channel: "blog" });
    const approvedEvents = await http.get(`/api/cases/${approved.body.case.id}/events`).expect(200);
    expect(approvedEvents.body.map((event: { type: string }) => event.type)).toEqual([
      "ingested",
      "transitioned",
      "updated",
      "transitioned",
      "review_decided",
    ]);

    const rejected = await http
      .post(`/api/pipelines/${pipeline.body.id}/cases`)
      .send({ caseKey: "reject-reason", title: "Reject reason" })
      .expect(201);
    await http.post(`/api/cases/${rejected.body.case.id}/transition`).send({ toStageKey: "review", expectedVersion: 1 }).expect(200);
    await http.post(`/api/cases/${rejected.body.case.id}/review`).send({ decision: "reject", expectedVersion: 2 }).expect(422);
    const reason = "  Keep this exact reason.  ";
    await http.post(`/api/cases/${rejected.body.case.id}/review`).send({ decision: "reject", reason, expectedVersion: 2 }).expect(200);
    const rejectedEvents = await http.get(`/api/cases/${rejected.body.case.id}/events`).expect(200);
    const reviewEvent = rejectedEvents.body.find((event: { type: string }) => event.type === "review_decided");
    expect(reviewEvent.payload.reason).toBe(reason);
  });

  it("aggregates the review inbox across pipelines with parent and review config context", async () => {
    const company = await seedCompany();
    const http = request(app(boardActor));
    const first = await http.post(`/api/companies/${company.id}/pipelines`).send({ key: "inbox-a", name: "Inbox A" }).expect(201);
    const second = await http.post(`/api/companies/${company.id}/pipelines`).send({ key: "inbox-b", name: "Inbox B" }).expect(201);

    const parent = await http
      .post(`/api/pipelines/${first.body.id}/cases`)
      .send({ caseKey: "parent", title: "Parent" })
      .expect(201);
    const child = await http
      .post(`/api/pipelines/${first.body.id}/cases`)
      .send({ caseKey: "child", title: "Child", parentCaseId: parent.body.case.id })
      .expect(201);
    await http.post(`/api/cases/${child.body.case.id}/transition`).send({ toStageKey: "review", expectedVersion: 1 }).expect(200);

    const other = await http
      .post(`/api/pipelines/${second.body.id}/cases`)
      .send({ caseKey: "other", title: "Other" })
      .expect(201);
    await http.post(`/api/cases/${other.body.case.id}/transition`).send({ toStageKey: "review", expectedVersion: 1 }).expect(200);

    const notReview = await http
      .post(`/api/pipelines/${second.body.id}/cases`)
      .send({ caseKey: "not-review", title: "Not review" })
      .expect(201);
    await http.post(`/api/cases/${notReview.body.case.id}/transition`).send({ toStageKey: "done", expectedVersion: 1 }).expect(200);

    const inbox = await http.get(`/api/companies/${company.id}/review-cases`).expect(200);
    expect(inbox.body).toHaveLength(2);
    expect(inbox.body.map((row: { pipeline: { key: string } }) => row.pipeline.key).sort()).toEqual(["inbox-a", "inbox-b"]);
    const childRow = inbox.body.find((row: { case: { id: string } }) => row.case.id === child.body.case.id);
    expect(childRow.parentCase.id).toBe(parent.body.case.id);
    expect(childRow.reviewConfig).toMatchObject({
      approveToStageKey: "done",
      rejectToStageKey: "cancelled",
      requireRejectReason: true,
      reviewerKind: "human",
    });
  });

  it("bulk reviews partial successes without aborting stale items", async () => {
    const company = await seedCompany();
    const http = request(app(boardActor));
    const pipeline = await http.post(`/api/companies/${company.id}/pipelines`).send({ key: "bulk-review", name: "Bulk review" }).expect(201);
    const caseIds: string[] = [];
    for (let index = 0; index < 50; index += 1) {
      const created = await http
        .post(`/api/pipelines/${pipeline.body.id}/cases`)
        .send({ caseKey: `bulk-${index}`, title: `Bulk ${index}` })
        .expect(201);
      await http.post(`/api/cases/${created.body.case.id}/transition`).send({ toStageKey: "review", expectedVersion: 1 }).expect(200);
      caseIds.push(created.body.case.id);
    }
    for (const staleCaseId of caseIds.slice(0, 3)) {
      await http.patch(`/api/cases/${staleCaseId}`).send({ title: "Stale before bulk", expectedVersion: 2 }).expect(200);
    }

    const bulk = await http
      .post(`/api/companies/${company.id}/review-cases/bulk`)
      .send({ items: caseIds.map((caseId) => ({ caseId, decision: "approve", expectedVersion: 2 })) })
      .expect(200);

    expect(bulk.body.results.filter((item: { ok: boolean }) => item.ok)).toHaveLength(47);
    const failed = bulk.body.results.filter((item: { ok: boolean }) => !item.ok);
    expect(failed).toHaveLength(3);
    expect(failed.every((item: { error: { code: string } }) => item.error.code === "version_conflict")).toBe(true);
  });

  it("returns conflict bodies with code, current version, and stage", async () => {
    const company = await seedCompany();
    const http = request(app(boardActor));
    const pipelineRes = await http.post(`/api/companies/${company.id}/pipelines`).send({ key: "conflict", name: "Conflict" }).expect(201);
    const caseRes = await http.post(`/api/pipelines/${pipelineRes.body.id}/cases`).send({ caseKey: "conflict", title: "Conflict" }).expect(201);
    await http.patch(`/api/cases/${caseRes.body.case.id}`).send({ title: "Updated", expectedVersion: 1 }).expect(200);

    const res = await http.patch(`/api/cases/${caseRes.body.case.id}`).send({ title: "Stale", expectedVersion: 1 });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("version_conflict");
    expect(res.body.details.version).toBe(2);
    expect(res.body.details.stage.key).toBe("intake");
  });
});
