CREATE UNIQUE INDEX archive_filing_private_identity ON archive_filing_suggestions(id,tenant_id,user_id);
CREATE TABLE archive_records (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 user_id uuid NOT NULL REFERENCES users(id),
 suggestion_id uuid NOT NULL UNIQUE,
 state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','archived')),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>=1),
 metadata jsonb NOT NULL CHECK(jsonb_typeof(metadata)='object'),
 filename text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 archived_at timestamptz,
 confirmed_by uuid REFERENCES users(id),
 FOREIGN KEY(suggestion_id,tenant_id,user_id) REFERENCES archive_filing_suggestions(id,tenant_id,user_id),
 CHECK((state='draft' AND archived_at IS NULL AND confirmed_by IS NULL) OR
 (state='archived' AND archived_at IS NOT NULL AND confirmed_by IS NOT NULL AND confirmed_by=user_id))
);
CREATE INDEX archive_records_private_list ON archive_records(tenant_id,user_id,state,archived_at DESC,id DESC);
ALTER TABLE archive_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE archive_records FORCE ROW LEVEL SECURITY;
CREATE POLICY archive_records_private ON archive_records
 USING(tenant_id::text=current_setting('app.tenant_id',true) AND user_id::text=current_setting('app.user_id',true))
 WITH CHECK(tenant_id::text=current_setting('app.tenant_id',true) AND user_id::text=current_setting('app.user_id',true));
CREATE FUNCTION archive_records_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Archive records are immutable'; END IF;
  IF OLD.state='archived' OR NEW.id<>OLD.id OR NEW.tenant_id<>OLD.tenant_id OR NEW.user_id<>OLD.user_id
   OR NEW.suggestion_id<>OLD.suggestion_id OR NEW.created_at<>OLD.created_at THEN
   RAISE EXCEPTION 'Archive record identity and confirmed records are immutable';
  END IF;
  RETURN NEW;
 END
$$;
CREATE TRIGGER archive_records_no_rewrite BEFORE UPDATE OR DELETE ON archive_records FOR EACH ROW EXECUTE FUNCTION archive_records_immutable();
