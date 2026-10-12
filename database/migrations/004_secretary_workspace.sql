-- Private secretary conversation and local task queue. No execution credentials are stored here.
CREATE TABLE secretary_workspaces (
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 user_id uuid NOT NULL REFERENCES users(id),
 revision integer NOT NULL DEFAULT 0,
 board jsonb NOT NULL DEFAULT '{"messages":[],"tasks":[],"batches":[]}',
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,user_id)
);
ALTER TABLE secretary_workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE secretary_workspaces FORCE ROW LEVEL SECURITY;
CREATE POLICY secretary_private ON secretary_workspaces
 USING (tenant_id::text=current_setting('app.tenant_id',true) AND user_id::text=current_setting('app.user_id',true))
 WITH CHECK (tenant_id::text=current_setting('app.tenant_id',true) AND user_id::text=current_setting('app.user_id',true));
