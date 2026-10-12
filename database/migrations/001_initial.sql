CREATE TABLE users (
 id uuid PRIMARY KEY, subject text UNIQUE NOT NULL, email text UNIQUE NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), CHECK (email = lower(email))
);
CREATE TABLE tenants (
 id uuid PRIMARY KEY, name text NOT NULL, plan text NOT NULL DEFAULT 'personal' CHECK(plan IN ('personal','enterprise')),
 subscription_status text NOT NULL DEFAULT 'none', stripe_customer_id text UNIQUE,
 stripe_subscription_id text UNIQUE, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE memberships (
 tenant_id uuid NOT NULL REFERENCES tenants(id), user_id uuid NOT NULL REFERENCES users(id),
 role text NOT NULL CHECK(role IN ('owner','admin','member')), PRIMARY KEY(tenant_id,user_id)
);
CREATE TABLE invitations (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), email text NOT NULL,
 role text NOT NULL CHECK(role IN ('admin','member')), token_hash text UNIQUE NOT NULL,
 expires_at timestamptz NOT NULL, accepted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE agents (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), profile jsonb NOT NULL,
 created_by uuid NOT NULL REFERENCES users(id), version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,id)
);
CREATE TABLE conversations (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, user_id uuid NOT NULL REFERENCES users(id), agent_id uuid NOT NULL,
 runtime_session_id text UNIQUE NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,agent_id) REFERENCES agents(tenant_id,id), UNIQUE(tenant_id,user_id,id)
);
CREATE TABLE usage_events (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), user_id uuid NOT NULL REFERENCES users(id),
 agent_id uuid REFERENCES agents(id), request_id uuid NOT NULL, operation text NOT NULL DEFAULT 'chat',
 status text NOT NULL CHECK(status IN ('pending','completed','failed','unknown')),
 input_tokens bigint NOT NULL DEFAULT 0, output_tokens bigint NOT NULL DEFAULT 0,
 duration_ms bigint NOT NULL DEFAULT 0, charge_microusd bigint NOT NULL DEFAULT 0,
 rate_snapshot jsonb NOT NULL DEFAULT '{}', result jsonb, provider_request_id text,
 billed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,user_id,request_id)
);
CREATE INDEX usage_tenant_date ON usage_events(tenant_id,created_at);
CREATE TABLE payment_events (id text PRIMARY KEY, event_type text NOT NULL, processed_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE audit_events (
 id uuid PRIMARY KEY, tenant_id uuid REFERENCES tenants(id), user_id uuid REFERENCES users(id),
 action text NOT NULL, target_id text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE office_events (
 seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id),
 action jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX office_events_tenant_seq ON office_events(tenant_id,seq);
-- Every tenant-owned query is additionally scoped in the application; RLS protects accidental omissions.
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents FORCE ROW LEVEL SECURITY;
CREATE POLICY agents_tenant ON agents USING (tenant_id::text=current_setting('app.tenant_id',true));
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations FORCE ROW LEVEL SECURITY;
CREATE POLICY conversations_tenant_user ON conversations USING (
 tenant_id::text=current_setting('app.tenant_id',true) AND user_id::text=current_setting('app.user_id',true));
ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_events FORCE ROW LEVEL SECURITY;
CREATE POLICY usage_tenant ON usage_events USING (tenant_id::text=current_setting('app.tenant_id',true));
ALTER TABLE office_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE office_events FORCE ROW LEVEL SECURITY;
CREATE POLICY office_tenant ON office_events USING (tenant_id::text=current_setting('app.tenant_id',true));
