CREATE TABLE department_conversations (
 tenant_id uuid NOT NULL REFERENCES tenants(id), user_id uuid NOT NULL REFERENCES users(id), department text NOT NULL,
 messages jsonb NOT NULL DEFAULT '[]', revision integer NOT NULL DEFAULT 0, PRIMARY KEY(tenant_id,user_id,department)
);
CREATE TABLE workspace_files (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), user_id uuid NOT NULL REFERENCES users(id),
 name text NOT NULL, mime text NOT NULL, data bytea NOT NULL CHECK(octet_length(data)<=6291456), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE skill_assignments (
 tenant_id uuid NOT NULL REFERENCES tenants(id), skill_id uuid NOT NULL REFERENCES installed_skills(id) ON DELETE CASCADE,
 department text NOT NULL, PRIMARY KEY(tenant_id,skill_id,department)
);
ALTER TABLE department_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE department_conversations FORCE ROW LEVEL SECURITY;
CREATE POLICY department_private ON department_conversations USING(tenant_id::text=current_setting('app.tenant_id',true) AND user_id::text=current_setting('app.user_id',true));
ALTER TABLE workspace_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_files FORCE ROW LEVEL SECURITY;
CREATE POLICY files_private ON workspace_files USING(tenant_id::text=current_setting('app.tenant_id',true) AND user_id::text=current_setting('app.user_id',true));
ALTER TABLE skill_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE skill_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY skill_assignment_tenant ON skill_assignments USING(tenant_id::text=current_setting('app.tenant_id',true));
