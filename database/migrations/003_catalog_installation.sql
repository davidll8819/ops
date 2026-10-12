ALTER TABLE installed_skills ADD COLUMN catalog_id text;
ALTER TABLE installed_skills ADD COLUMN catalog_source text;
ALTER TABLE installed_skills ADD COLUMN provenance jsonb NOT NULL DEFAULT '{}';
ALTER TABLE installed_skills DROP CONSTRAINT installed_skills_tenant_id_name_key;
CREATE UNIQUE INDEX installed_upload_name ON installed_skills(tenant_id,name) WHERE catalog_id IS NULL;
CREATE UNIQUE INDEX installed_catalog_entry ON installed_skills(tenant_id,catalog_id) WHERE catalog_id IS NOT NULL;
