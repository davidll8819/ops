CREATE TABLE archive_filing_suggestions (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 user_id uuid NOT NULL REFERENCES users(id),
 extraction_id uuid NOT NULL UNIQUE,
 serial_number bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 state text NOT NULL DEFAULT 'failed' CHECK(state IN ('processing','ready','failed')),
 attempt_id uuid,
 lease_until timestamptz,
 source jsonb NOT NULL CHECK(jsonb_typeof(source)='object'),
 result jsonb,
 error text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(extraction_id,tenant_id,user_id) REFERENCES archive_documents(id,tenant_id,user_id),
 CHECK(state<>'processing' OR (attempt_id IS NOT NULL AND lease_until IS NOT NULL)),
 CHECK(state<>'ready' OR (result IS NOT NULL AND jsonb_typeof(result)='object'))
);
ALTER TABLE archive_filing_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE archive_filing_suggestions FORCE ROW LEVEL SECURITY;
CREATE POLICY archive_filing_private ON archive_filing_suggestions
 USING(tenant_id::text=current_setting('app.tenant_id',true) AND user_id::text=current_setting('app.user_id',true))
 WITH CHECK(tenant_id::text=current_setting('app.tenant_id',true) AND user_id::text=current_setting('app.user_id',true));
CREATE FUNCTION archive_filing_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Archive filing history is immutable'; END IF;
  IF OLD.state='ready' OR NEW.id<>OLD.id OR NEW.tenant_id<>OLD.tenant_id OR NEW.user_id<>OLD.user_id
   OR NEW.extraction_id<>OLD.extraction_id OR NEW.serial_number<>OLD.serial_number
   OR NEW.source IS DISTINCT FROM OLD.source OR NEW.created_at<>OLD.created_at THEN
   RAISE EXCEPTION 'Archive filing identity and ready results are immutable';
  END IF;
  RETURN NEW;
 END
$$;
CREATE TRIGGER archive_filing_no_rewrite BEFORE UPDATE OR DELETE ON archive_filing_suggestions FOR EACH ROW EXECUTE FUNCTION archive_filing_immutable();
