ALTER TABLE operations_submissions DROP CONSTRAINT operations_submissions_state_check;
ALTER TABLE operations_submissions ADD CONSTRAINT operations_submissions_state_check CHECK(state IN ('reserved','failed','submitted','uncertain'));
