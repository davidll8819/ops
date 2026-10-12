-- Credentials are encrypted by the application; operational records belong to a tenant.
CREATE TABLE operations_settings (
 tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
 encrypted_config text NOT NULL,
 revision integer NOT NULL DEFAULT 1,
 updated_by uuid NOT NULL REFERENCES users(id),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE operations_publications (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 requested_by uuid REFERENCES users(id),
 approved_by uuid REFERENCES users(id),
 payload jsonb NOT NULL,
 payload_hash text NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','rejected','submitting','submitted','uncertain')),
 result jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,payload_hash)
);
CREATE TABLE operations_events (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 user_id uuid REFERENCES users(id),
 kind text NOT NULL,
 reference text,
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE operations_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE operations_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY operations_settings_tenant ON operations_settings USING(tenant_id::text=current_setting('app.tenant_id',true)) WITH CHECK(tenant_id::text=current_setting('app.tenant_id',true));
ALTER TABLE operations_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE operations_publications FORCE ROW LEVEL SECURITY;
CREATE POLICY operations_publications_tenant ON operations_publications USING(tenant_id::text=current_setting('app.tenant_id',true)) WITH CHECK(tenant_id::text=current_setting('app.tenant_id',true));
ALTER TABLE operations_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE operations_events FORCE ROW LEVEL SECURITY;
CREATE POLICY operations_events_tenant ON operations_events USING(tenant_id::text=current_setting('app.tenant_id',true)) WITH CHECK(tenant_id::text=current_setting('app.tenant_id',true));
