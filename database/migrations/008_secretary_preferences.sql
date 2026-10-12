-- Personal preferences stay under the existing tenant + user row-level policy.
ALTER TABLE secretary_workspaces ADD COLUMN preferences jsonb NOT NULL DEFAULT '{}';
