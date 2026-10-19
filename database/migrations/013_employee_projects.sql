-- Keep every existing workspace ID, file revision and run association.
ALTER TABLE employee_workspaces DROP CONSTRAINT employee_workspaces_tenant_id_user_id_key;
ALTER TABLE employee_workspaces ADD COLUMN is_default boolean NOT NULL DEFAULT false;
ALTER TABLE employee_workspaces ADD COLUMN messages jsonb NOT NULL DEFAULT '[]';
ALTER TABLE employee_workspaces ADD COLUMN conversation_revision integer NOT NULL DEFAULT 0;
UPDATE employee_workspaces SET is_default=true;
UPDATE employee_workspaces w SET messages=c.messages,conversation_revision=c.revision
FROM department_conversations c
WHERE c.tenant_id=w.tenant_id AND c.user_id=w.user_id AND c.department='dev';
CREATE UNIQUE INDEX employee_workspace_default ON employee_workspaces(tenant_id,user_id) WHERE is_default;
ALTER TABLE employee_workspaces ADD CONSTRAINT employee_workspace_ownership UNIQUE(id,tenant_id,user_id);
ALTER TABLE employee_runs ADD CONSTRAINT employee_run_workspace_ownership
 FOREIGN KEY(workspace_id,tenant_id,user_id) REFERENCES employee_workspaces(id,tenant_id,user_id);
CREATE INDEX employee_runs_project_recent ON employee_runs(workspace_id,tenant_id,user_id,created_at DESC);

CREATE FUNCTION employee_project_snapshot_bytes(snapshot jsonb) RETURNS bigint
 LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT coalesce(sum(octet_length(decode(item->>'contentBase64','base64'))),0)::bigint
 FROM jsonb_array_elements(snapshot) item
$$;
CREATE TABLE employee_project_versions (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL,
 tenant_id uuid NOT NULL REFERENCES tenants(id),user_id uuid NOT NULL REFERENCES users(id),
 label text NOT NULL CHECK(char_length(label) BETWEEN 1 AND 80),
 kind text NOT NULL CHECK(kind IN ('manual','before_restore')),
 source_revision integer NOT NULL CHECK(source_revision>=0),
 files jsonb NOT NULL CHECK(jsonb_typeof(files)='array' AND jsonb_array_length(files)<=200),
 snapshot_bytes bigint GENERATED ALWAYS AS (employee_project_snapshot_bytes(files)) STORED,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,tenant_id,user_id) REFERENCES employee_workspaces(id,tenant_id,user_id),
 CHECK(snapshot_bytes<=8388608)
);
CREATE INDEX employee_project_versions_recent ON employee_project_versions(workspace_id,created_at DESC,id DESC);
ALTER TABLE employee_project_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_project_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY employee_project_version_private ON employee_project_versions
 USING(tenant_id::text=current_setting('app.tenant_id',true) AND user_id::text=current_setting('app.user_id',true));
CREATE FUNCTION employee_project_version_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN RAISE EXCEPTION 'Saved project versions are immutable'; END
$$;
CREATE TRIGGER employee_project_version_no_update BEFORE UPDATE ON employee_project_versions
 FOR EACH ROW EXECUTE FUNCTION employee_project_version_immutable();
