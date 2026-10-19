CREATE TABLE operations_briefs (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), user_id uuid NOT NULL REFERENCES users(id),
 source_message_id uuid NOT NULL, source_revision integer NOT NULL, title text NOT NULL, text text NOT NULL,
 messages jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,user_id,source_message_id), UNIQUE(id,tenant_id,user_id)
);
ALTER TABLE operations_briefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE operations_briefs FORCE ROW LEVEL SECURITY;
CREATE POLICY operations_briefs_private ON operations_briefs USING(tenant_id::text=current_setting('app.tenant_id',true) AND user_id::text=current_setting('app.user_id',true)) WITH CHECK(tenant_id::text=current_setting('app.tenant_id',true) AND user_id::text=current_setting('app.user_id',true));
CREATE FUNCTION operations_briefs_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Operations briefs are immutable'; END $$;
CREATE TRIGGER operations_briefs_no_rewrite BEFORE UPDATE OR DELETE ON operations_briefs FOR EACH ROW EXECUTE FUNCTION operations_briefs_immutable();

CREATE TABLE operations_submissions (
 id uuid NOT NULL, tenant_id uuid NOT NULL REFERENCES tenants(id), user_id uuid NOT NULL REFERENCES users(id),
 fingerprint text NOT NULL, brief_id uuid, state text NOT NULL CHECK(state IN ('reserved','submitted','uncertain')),
 runtime_task_id text CHECK(runtime_task_id ~ '^[a-f0-9]{24}$'),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,user_id,id),
 FOREIGN KEY(brief_id,tenant_id,user_id) REFERENCES operations_briefs(id,tenant_id,user_id)
);
ALTER TABLE operations_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE operations_submissions FORCE ROW LEVEL SECURITY;
CREATE POLICY operations_submissions_private ON operations_submissions USING(tenant_id::text=current_setting('app.tenant_id',true) AND user_id::text=current_setting('app.user_id',true)) WITH CHECK(tenant_id::text=current_setting('app.tenant_id',true) AND user_id::text=current_setting('app.user_id',true));
