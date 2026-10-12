CREATE TABLE secretary_reminders (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), user_id uuid NOT NULL REFERENCES users(id),
 title text NOT NULL, next_at timestamptz NOT NULL, repeat_daily boolean NOT NULL DEFAULT false,
 active boolean NOT NULL DEFAULT true, last_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE secretary_reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE secretary_reminders FORCE ROW LEVEL SECURITY;
CREATE POLICY reminders_private ON secretary_reminders USING(tenant_id::text=current_setting('app.tenant_id',true) AND user_id::text=current_setting('app.user_id',true));
