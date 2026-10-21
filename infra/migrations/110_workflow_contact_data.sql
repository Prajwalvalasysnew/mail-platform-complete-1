-- Production workflows: contact tags/attributes/time zone that conditions and
-- "Update contact" steps read and write, plus scheduled/audience entry sources.
ALTER TABLE audience_contacts
  ADD COLUMN tags TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN timezone TEXT;
ALTER TABLE audience_contacts ADD CONSTRAINT audience_contacts_attributes_object CHECK (jsonb_typeof(attributes) = 'object');
CREATE INDEX audience_contacts_tags ON audience_contacts USING GIN (tags);

ALTER TABLE workflow_runs DROP CONSTRAINT IF EXISTS workflow_runs_trigger_source_check;
ALTER TABLE workflow_runs ADD CONSTRAINT workflow_runs_trigger_source_check
  CHECK (trigger_source IN ('event', 'api', 'manual', 'test', 'audience', 'schedule'));

-- Date-triggered workflows enroll once per local day.
ALTER TABLE workflows ADD COLUMN date_trigger_swept_on DATE;
CREATE INDEX workflows_active_trigger_type ON workflows (trigger_type) WHERE status = 'active';
