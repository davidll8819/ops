-- Persisted jobs reference the existing private task board; no second task inventory.
CREATE TABLE task_jobs (
 tenant_id uuid NOT NULL REFERENCES tenants(id), user_id uuid NOT NULL REFERENCES users(id), task_id text NOT NULL,
 state text NOT NULL CHECK(state IN ('queued','running','completed','blocked')),
 claim_id uuid, lease_until timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,user_id,task_id)
);
ALTER TABLE task_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY jobs_private ON task_jobs USING(tenant_id::text=current_setting('app.tenant_id',true) AND user_id::text=current_setting('app.user_id',true));
CREATE TABLE research_settings (
 tenant_id uuid PRIMARY KEY REFERENCES tenants(id), encrypted_config text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE research_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE research_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY research_tenant ON research_settings USING(tenant_id::text=current_setting('app.tenant_id',true));
-- New publication policy: existing unknown/submitted records must never be replayed.
UPDATE operations_publications SET execution_mode='manual',updated_at=now() WHERE state='pending';
ALTER TABLE operations_publications ALTER COLUMN execution_mode SET DEFAULT 'manual';
