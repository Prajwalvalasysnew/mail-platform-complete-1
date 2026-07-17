-- Workflow automation engine (enterprise SaaS-grade automations).
--
-- Model:
--   workflows           — the automation container + lifecycle status. The
--                         draft definition lives here (draft_definition);
--                         published, immutable snapshots live in
--                         workflow_versions and are what runs execute.
--   workflow_versions   — append-only version history ("Version history" in
--                         the builder UI). Publishing snapshots the draft.
--   workflow_runs       — one row per subject (recipient email) journeying
--                         through a published version. Durable state machine:
--                         BullMQ jobs are the fast path, these rows are the
--                         source of truth (send_outbox pattern — a scheduler
--                         sweep recovers runs whose Redis job was lost).
--   workflow_run_steps  — per-run step execution log (audit trail + the
--                         idempotency ledger for at-least-once step delivery).
--   workflow_step_stats — per (version, step) counters that power the builder
--                         overlay numbers (entered / completed / failed).
--
-- Trigger matching is served by an expression index on the published trigger
-- event type (denormalized onto workflows at publish time) so the event
-- worker's hot path is a single indexed lookup per event.

CREATE TABLE IF NOT EXISTS workflows (
    id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id           UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    name                  TEXT NOT NULL,
    description           TEXT,
    status                TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'active', 'paused', 'archived')),
    -- Working copy edited via the API. Snapshotted into workflow_versions on
    -- publish; never executed directly.
    draft_definition      JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- Currently-published version (what active/paused runs execute).
    published_version_id  UUID,
    published_version     INTEGER,
    -- Denormalized from the published definition for O(1) trigger matching.
    trigger_type          TEXT,             -- 'event' | 'api'
    trigger_event_type    TEXT,             -- e.g. 'opened' when trigger_type='event'
    -- Re-entry policy: can the same subject go through again, and how soon?
    allow_reentry         BOOLEAN NOT NULL DEFAULT FALSE,
    reentry_cooldown_seconds INTEGER NOT NULL DEFAULT 0 CHECK (reentry_cooldown_seconds >= 0),
    created_by_user_id    UUID,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (customer_id, name)
);

CREATE INDEX IF NOT EXISTS idx_workflows_customer
    ON workflows (customer_id, updated_at DESC);
-- Event-worker hot path: active workflows listening for this event type.
CREATE INDEX IF NOT EXISTS idx_workflows_trigger
    ON workflows (customer_id, trigger_event_type)
    WHERE status = 'active' AND trigger_type = 'event';

CREATE TABLE IF NOT EXISTS workflow_versions (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    workflow_id   UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    customer_id   UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    version       INTEGER NOT NULL,
    definition    JSONB NOT NULL,
    notes         TEXT,
    published_by_user_id UUID,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (workflow_id, version)
);

CREATE INDEX IF NOT EXISTS idx_workflow_versions_workflow
    ON workflow_versions (workflow_id, version DESC);

-- Now that workflow_versions exists, point workflows at it. Deleting a version
-- row is prevented while it is the published one (RESTRICT) — history rows are
-- append-only and only removed via workflow CASCADE.
ALTER TABLE workflows
    ADD CONSTRAINT fk_workflows_published_version
    FOREIGN KEY (published_version_id) REFERENCES workflow_versions(id) ON DELETE RESTRICT;

CREATE TABLE IF NOT EXISTS workflow_runs (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    workflow_id     UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    version_id      UUID NOT NULL REFERENCES workflow_versions(id) ON DELETE CASCADE,
    version         INTEGER NOT NULL,
    -- The entity travelling through the workflow. Email is the platform's
    -- native subject identity (recipients), lowercased for matching.
    subject_email   TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'running'
        CHECK (status IN ('running', 'waiting_delay', 'waiting_event',
                          'completed', 'goal_met', 'exited', 'failed', 'canceled')),
    current_step_id TEXT,
    -- How the run started + its data bag ({{trigger.*}} / {{context.*}} in
    -- templates and condition operands).
    trigger_source  TEXT NOT NULL DEFAULT 'event'
        CHECK (trigger_source IN ('event', 'api', 'manual', 'test')),
    context         JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- Durable timer: when a waiting_delay / waiting_event run must be woken.
    -- The scheduler sweep re-arms any overdue row whose BullMQ job vanished.
    wake_at         TIMESTAMPTZ,
    -- waiting_event bookkeeping: what we're waiting for (denormalized from the
    -- step for indexed matching by the event dispatcher).
    waiting_event_types TEXT[],
    -- Loop guard: total steps executed in this run.
    steps_executed  INTEGER NOT NULL DEFAULT 0,
    goal_met_at     TIMESTAMPTZ,
    goal_step_id    TEXT,
    error           TEXT,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at     TIMESTAMPTZ,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow
    ON workflow_runs (workflow_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_customer
    ON workflow_runs (customer_id, started_at DESC);
-- Re-entry check + event dispatch both look up a subject's runs in a workflow.
CREATE INDEX IF NOT EXISTS idx_workflow_runs_subject
    ON workflow_runs (workflow_id, subject_email, started_at DESC);
-- One in-flight run per (workflow, subject): the concurrent-trigger guard.
CREATE UNIQUE INDEX IF NOT EXISTS uq_workflow_runs_active_subject
    ON workflow_runs (workflow_id, subject_email)
    WHERE status IN ('running', 'waiting_delay', 'waiting_event');
-- Scheduler sweep: overdue timers.
CREATE INDEX IF NOT EXISTS idx_workflow_runs_wake
    ON workflow_runs (wake_at)
    WHERE status IN ('waiting_delay', 'waiting_event');
-- Event dispatcher: waiting runs for a customer+subject.
CREATE INDEX IF NOT EXISTS idx_workflow_runs_waiting_subject
    ON workflow_runs (customer_id, subject_email)
    WHERE status IN ('running', 'waiting_delay', 'waiting_event');

CREATE TABLE IF NOT EXISTS workflow_run_steps (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    run_id       UUID NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    customer_id  UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    step_id      TEXT NOT NULL,
    step_type    TEXT NOT NULL,
    -- seq: order within the run. (run_id, seq) is unique so re-executed jobs
    -- can detect a step that already ran (at-least-once => effectively-once).
    seq          INTEGER NOT NULL,
    status       TEXT NOT NULL DEFAULT 'completed'
        CHECK (status IN ('completed', 'failed', 'skipped', 'waiting')),
    -- What the step did (message_id sent, branch taken, webhook status, ...).
    result       JSONB NOT NULL DEFAULT '{}'::jsonb,
    error        TEXT,
    executed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (run_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_workflow_run_steps_run
    ON workflow_run_steps (run_id, seq);

CREATE TABLE IF NOT EXISTS workflow_step_stats (
    workflow_id  UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    customer_id  UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    version      INTEGER NOT NULL,
    step_id      TEXT NOT NULL,
    entered      BIGINT NOT NULL DEFAULT 0,
    completed    BIGINT NOT NULL DEFAULT 0,
    failed       BIGINT NOT NULL DEFAULT 0,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (workflow_id, version, step_id)
);

-- updated_at maintenance (set_updated_at() is defined in 001_init.sql).
CREATE TRIGGER workflows_set_updated_at
    BEFORE UPDATE ON workflows
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER workflow_runs_set_updated_at
    BEFORE UPDATE ON workflow_runs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Fail-closed tenant RLS, matching migration 043. The worker/scheduler role
-- (BYPASSRLS service role) executes runs across tenants; the API role only
-- ever sees its own tenant's rows.
ALTER TABLE workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflows FORCE ROW LEVEL SECURITY;
CREATE POLICY workflows_tenant ON workflows FOR ALL
  USING (customer_id = current_tenant_id())
  WITH CHECK (customer_id = current_tenant_id());

ALTER TABLE workflow_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY workflow_versions_tenant ON workflow_versions FOR ALL
  USING (customer_id = current_tenant_id())
  WITH CHECK (customer_id = current_tenant_id());

ALTER TABLE workflow_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY workflow_runs_tenant ON workflow_runs FOR ALL
  USING (customer_id = current_tenant_id())
  WITH CHECK (customer_id = current_tenant_id());

ALTER TABLE workflow_run_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_run_steps FORCE ROW LEVEL SECURITY;
CREATE POLICY workflow_run_steps_tenant ON workflow_run_steps FOR ALL
  USING (customer_id = current_tenant_id())
  WITH CHECK (customer_id = current_tenant_id());

ALTER TABLE workflow_step_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_step_stats FORCE ROW LEVEL SECURITY;
CREATE POLICY workflow_step_stats_tenant ON workflow_step_stats FOR ALL
  USING (customer_id = current_tenant_id())
  WITH CHECK (customer_id = current_tenant_id());
