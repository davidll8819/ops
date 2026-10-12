-- Uploaded packages are private tenant data, never executable database content.
CREATE TABLE installed_skills (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 name text NOT NULL,
 description text NOT NULL,
 version text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('capability','workflow')),
 filename text NOT NULL,
 format text NOT NULL CHECK(format IN ('md','zip')),
 sha256 text NOT NULL,
 skill_file text NOT NULL,
 file_count integer NOT NULL CHECK(file_count > 0),
 expanded_bytes integer NOT NULL,
 package_data bytea NOT NULL CHECK(octet_length(package_data) <= 6291456),
 created_by uuid NOT NULL REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,name)
);
ALTER TABLE installed_skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE installed_skills FORCE ROW LEVEL SECURITY;
CREATE POLICY installed_skills_tenant ON installed_skills
 USING (tenant_id::text=current_setting('app.tenant_id',true))
 WITH CHECK (tenant_id::text=current_setting('app.tenant_id',true));
