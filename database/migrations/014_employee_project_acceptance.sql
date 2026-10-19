ALTER TABLE employee_project_versions ADD CONSTRAINT employee_project_version_ownership
 UNIQUE(id,workspace_id,tenant_id,user_id);

CREATE TABLE employee_project_acceptance (
 version_id uuid PRIMARY KEY, workspace_id uuid NOT NULL,
 tenant_id uuid NOT NULL REFERENCES tenants(id), user_id uuid NOT NULL REFERENCES users(id),
 revision integer NOT NULL CHECK(revision>0), entry text NOT NULL DEFAULT '',
 items jsonb NOT NULL CHECK(jsonb_typeof(items)='array' AND jsonb_array_length(items) BETWEEN 1 AND 20),
 instructions text NOT NULL DEFAULT '' CHECK(char_length(instructions)<=8000),
 limitations text NOT NULL DEFAULT '' CHECK(char_length(limitations)<=8000),
 system_check jsonb,
 updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(version_id,workspace_id,tenant_id,user_id)
 REFERENCES employee_project_versions(id,workspace_id,tenant_id,user_id)
);
CREATE TABLE employee_project_deliveries (
 id uuid PRIMARY KEY, version_id uuid NOT NULL UNIQUE, workspace_id uuid NOT NULL,
 tenant_id uuid NOT NULL REFERENCES tenants(id), user_id uuid NOT NULL REFERENCES users(id),
 version_label text NOT NULL, source_revision integer NOT NULL CHECK(source_revision>=0),
 label text NOT NULL CHECK(char_length(label) BETWEEN 1 AND 80), entry text NOT NULL,
 items jsonb NOT NULL CHECK(jsonb_typeof(items)='array' AND jsonb_array_length(items) BETWEEN 1 AND 20),
 system_check jsonb NOT NULL,
 instructions text NOT NULL CHECK(char_length(instructions) BETWEEN 1 AND 8000),
 limitations text NOT NULL CHECK(char_length(limitations) BETWEEN 1 AND 8000),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(version_id,workspace_id,tenant_id,user_id)
 REFERENCES employee_project_versions(id,workspace_id,tenant_id,user_id)
);
CREATE INDEX employee_project_deliveries_recent
 ON employee_project_deliveries(workspace_id,created_at DESC,id DESC);
ALTER TABLE employee_project_acceptance ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_project_acceptance FORCE ROW LEVEL SECURITY;
CREATE POLICY employee_project_acceptance_private ON employee_project_acceptance
 USING(tenant_id::text=current_setting('app.tenant_id',true) AND user_id::text=current_setting('app.user_id',true));
ALTER TABLE employee_project_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_project_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY employee_project_delivery_private ON employee_project_deliveries
 USING(tenant_id::text=current_setting('app.tenant_id',true) AND user_id::text=current_setting('app.user_id',true));
CREATE FUNCTION employee_project_delivery_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN RAISE EXCEPTION 'Formal project deliveries are immutable'; END
$$;
CREATE TRIGGER employee_project_delivery_no_update BEFORE UPDATE ON employee_project_deliveries
 FOR EACH ROW EXECUTE FUNCTION employee_project_delivery_immutable();
