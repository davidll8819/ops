-- Derived private extraction only; original workspace bytes and conversation data remain unchanged.
CREATE UNIQUE INDEX workspace_files_private_identity ON workspace_files(id,tenant_id,user_id);
CREATE TABLE archive_documents (
 id uuid PRIMARY KEY,
 file_id uuid NOT NULL UNIQUE,
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 user_id uuid NOT NULL REFERENCES users(id),
 sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 parser_version text NOT NULL,
 kind text CHECK(kind IN ('docx','pdf','xlsx')),
 state text NOT NULL CHECK(state IN ('processing','ready','failed')),
 attempt_id uuid NOT NULL,
 attempts integer NOT NULL DEFAULT 1 CHECK(attempts>0),
 lease_until timestamptz,
 error text,
 warnings jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(warnings)='array'),
 blocks jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(blocks)='array'),
 stats jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(file_id,tenant_id,user_id) REFERENCES workspace_files(id,tenant_id,user_id),
 CHECK((state='processing' AND lease_until IS NOT NULL) OR (state<>'processing' AND lease_until IS NULL)),
 CHECK(state<>'ready' OR (kind IS NOT NULL AND jsonb_array_length(blocks)>0 AND error IS NULL))
);
CREATE INDEX archive_documents_private ON archive_documents(tenant_id,user_id);
ALTER TABLE archive_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE archive_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY archive_documents_private ON archive_documents
 USING(tenant_id::text=current_setting('app.tenant_id',true) AND user_id::text=current_setting('app.user_id',true))
 WITH CHECK(tenant_id::text=current_setting('app.tenant_id',true) AND user_id::text=current_setting('app.user_id',true));
CREATE FUNCTION archive_document_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN
  IF OLD.state='ready' THEN RAISE EXCEPTION 'Successful archive extractions are immutable'; END IF;
  IF (to_jsonb(OLD)-ARRAY['state','kind','attempt_id','attempts','lease_until','error','warnings','blocks','stats','updated_at'])
   IS DISTINCT FROM
   (to_jsonb(NEW)-ARRAY['state','kind','attempt_id','attempts','lease_until','error','warnings','blocks','stats','updated_at'])
  THEN RAISE EXCEPTION 'Archive source identity is immutable'; END IF;
  RETURN NEW;
 END
$$;
CREATE TRIGGER archive_document_no_rewrite BEFORE UPDATE ON archive_documents FOR EACH ROW EXECUTE FUNCTION archive_document_immutable();
