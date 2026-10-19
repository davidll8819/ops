-- Comparisons reference private immutable extractions; no existing records are changed.
CREATE UNIQUE INDEX archive_documents_private_identity ON archive_documents(id,tenant_id,user_id);
CREATE TABLE archive_comparisons (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 user_id uuid NOT NULL REFERENCES users(id),
 old_extraction_id uuid NOT NULL,
 new_extraction_id uuid NOT NULL,
 algorithm_version text NOT NULL,
 sources jsonb NOT NULL CHECK(jsonb_typeof(sources)='object'),
 result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(old_extraction_id<>new_extraction_id),
 FOREIGN KEY(old_extraction_id,tenant_id,user_id) REFERENCES archive_documents(id,tenant_id,user_id),
 FOREIGN KEY(new_extraction_id,tenant_id,user_id) REFERENCES archive_documents(id,tenant_id,user_id),
 UNIQUE(tenant_id,user_id,old_extraction_id,new_extraction_id,algorithm_version)
);
CREATE INDEX archive_comparisons_private_history ON archive_comparisons(tenant_id,user_id,created_at DESC,id);
ALTER TABLE archive_comparisons ENABLE ROW LEVEL SECURITY;
ALTER TABLE archive_comparisons FORCE ROW LEVEL SECURITY;
CREATE POLICY archive_comparisons_private ON archive_comparisons
 USING(tenant_id::text=current_setting('app.tenant_id',true) AND user_id::text=current_setting('app.user_id',true))
 WITH CHECK(tenant_id::text=current_setting('app.tenant_id',true) AND user_id::text=current_setting('app.user_id',true));
CREATE FUNCTION archive_comparison_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN
  RAISE EXCEPTION 'Archive comparisons are immutable';
 END
$$;
CREATE TRIGGER archive_comparison_no_rewrite BEFORE UPDATE OR DELETE ON archive_comparisons FOR EACH ROW EXECUTE FUNCTION archive_comparison_immutable();
