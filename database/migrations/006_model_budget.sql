-- A reservation commits before a model request starts. Unknown outcomes retain the reservation.
CREATE TABLE model_daily_usage (
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 day date NOT NULL,
 used_tokens bigint NOT NULL DEFAULT 0 CHECK (used_tokens >= 0),
 reserved_tokens bigint NOT NULL DEFAULT 0 CHECK (reserved_tokens >= 0),
 PRIMARY KEY (tenant_id,day)
);
CREATE TABLE model_requests (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 user_id uuid REFERENCES users(id),
 day date NOT NULL,
 department text NOT NULL,
 model text NOT NULL,
 reserved_tokens bigint NOT NULL CHECK (reserved_tokens > 0),
 input_tokens bigint,
 output_tokens bigint,
 state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','completed','rejected','unknown')),
 created_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz
);
CREATE INDEX model_requests_tenant_created ON model_requests(tenant_id,created_at DESC);
ALTER TABLE model_daily_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_daily_usage FORCE ROW LEVEL SECURITY;
CREATE POLICY model_daily_usage_tenant ON model_daily_usage USING(tenant_id::text=current_setting('app.tenant_id',true)) WITH CHECK(tenant_id::text=current_setting('app.tenant_id',true));
ALTER TABLE model_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY model_requests_tenant ON model_requests USING(tenant_id::text=current_setting('app.tenant_id',true)) WITH CHECK(tenant_id::text=current_setting('app.tenant_id',true));
