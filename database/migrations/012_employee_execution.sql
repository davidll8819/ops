CREATE TABLE employee_workspaces (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), user_id uuid NOT NULL REFERENCES users(id),
 name text NOT NULL DEFAULT '龙傲天项目', files jsonb NOT NULL DEFAULT '[]', revision integer NOT NULL DEFAULT 0,
 active_run_id uuid, lease_until timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,user_id), CHECK(jsonb_array_length(files)<=200), CHECK(octet_length(files::text)<=12000000)
);
CREATE TABLE employee_runs (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES employee_workspaces(id),
 tenant_id uuid NOT NULL REFERENCES tenants(id), user_id uuid NOT NULL REFERENCES users(id),
 state text NOT NULL CHECK(state IN ('running','completed','failed','interrupted')),
 request text NOT NULL, summary text NOT NULL DEFAULT '', steps jsonb NOT NULL DEFAULT '[]',
 created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 CHECK(jsonb_array_length(steps)<=32)
);
CREATE INDEX employee_runs_recent ON employee_runs(tenant_id,user_id,created_at DESC);
ALTER TABLE employee_workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_workspaces FORCE ROW LEVEL SECURITY;
CREATE POLICY employee_workspace_private ON employee_workspaces USING(tenant_id::text=current_setting('app.tenant_id',true) AND user_id::text=current_setting('app.user_id',true));
ALTER TABLE employee_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY employee_run_private ON employee_runs USING(tenant_id::text=current_setting('app.tenant_id',true) AND user_id::text=current_setting('app.user_id',true));
