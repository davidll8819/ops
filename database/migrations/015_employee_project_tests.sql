CREATE TABLE employee_project_test_runs (
 id uuid PRIMARY KEY, request_id uuid NOT NULL, version_id uuid NOT NULL,
 workspace_id uuid NOT NULL, tenant_id uuid NOT NULL REFERENCES tenants(id),
 user_id uuid NOT NULL REFERENCES users(id), version_label text NOT NULL,
 source_revision integer NOT NULL CHECK(source_revision>=0),
 snapshot_sha256 text NOT NULL CHECK(snapshot_sha256 ~ '^[a-f0-9]{64}$'),
 test_files jsonb NOT NULL CHECK(jsonb_typeof(test_files)='array'),
 command text NOT NULL, environment text NOT NULL,
 timeout_ms integer NOT NULL DEFAULT 60000 CHECK(timeout_ms=60000),
 state text NOT NULL CHECK(state IN ('running','passed','failed','no_tests','timed_out','interrupted','error','incomplete')),
 counts jsonb, cases jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(cases)='array'),
 exit_code integer CHECK(exit_code BETWEEN 0 AND 255), stdout text NOT NULL DEFAULT '', stderr text NOT NULL DEFAULT '',
 timed_out boolean NOT NULL DEFAULT false, truncated boolean NOT NULL DEFAULT false,
 detail text NOT NULL DEFAULT '', started_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz, lease_until timestamptz,
 UNIQUE(workspace_id,request_id),
 FOREIGN KEY(version_id,workspace_id,tenant_id,user_id)
 REFERENCES employee_project_versions(id,workspace_id,tenant_id,user_id),
 CHECK((state='running' AND finished_at IS NULL AND lease_until IS NOT NULL) OR
       (state<>'running' AND finished_at IS NOT NULL AND lease_until IS NULL))
);
CREATE UNIQUE INDEX employee_project_test_one_running ON employee_project_test_runs(workspace_id) WHERE state='running';
CREATE INDEX employee_project_tests_recent ON employee_project_test_runs(version_id,started_at DESC,id DESC);
ALTER TABLE employee_project_test_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_project_test_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY employee_project_test_private ON employee_project_test_runs
 USING(tenant_id::text=current_setting('app.tenant_id',true) AND user_id::text=current_setting('app.user_id',true));
CREATE FUNCTION employee_project_test_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN
  IF OLD.state<>'running' THEN RAISE EXCEPTION 'Terminal project test records are immutable'; END IF;
  IF (to_jsonb(OLD)-ARRAY['state','counts','cases','exit_code','stdout','stderr','timed_out','truncated','detail','finished_at','lease_until'])
    IS DISTINCT FROM
     (to_jsonb(NEW)-ARRAY['state','counts','cases','exit_code','stdout','stderr','timed_out','truncated','detail','finished_at','lease_until'])
  THEN RAISE EXCEPTION 'Project test identity is immutable'; END IF;
  RETURN NEW;
 END
$$;
CREATE TRIGGER employee_project_test_no_rewrite BEFORE UPDATE ON employee_project_test_runs
 FOR EACH ROW EXECUTE FUNCTION employee_project_test_immutable();
ALTER TABLE employee_project_deliveries ADD COLUMN automated_test jsonb;
