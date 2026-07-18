-- 2026-07-19: Run a script automatically the first time a device connects.
--
-- Adds an opt-in `run_on_connect` flag on `scripts`. When set, the first time a
-- device in the script's org comes online (device.online event), the script is
-- executed on it exactly once. `script_connect_runs` is the per-(script,device)
-- ledger that enforces "first connect only" — the UNIQUE index is the dedup that
-- makes concurrent device.online events race-safe (claim-then-run).
--
-- Tenancy (Shape 1, direct org_id): org_id is DENORMALIZED to the DEVICE's org
-- (like every other worker-created child row — automation_run_device_results,
-- software_deployments, alerts). That makes the table auto-discovered by the RLS
-- coverage contract test with a plain breeze_has_org_access(org_id) policy; no
-- allowlist entry is needed.
--
-- Idempotent: ADD COLUMN/CREATE TABLE/CREATE INDEX IF NOT EXISTS, DROP POLICY IF
-- EXISTS before each CREATE. autoMigrate wraps the file in a transaction — no
-- inner BEGIN/COMMIT.

ALTER TABLE scripts ADD COLUMN IF NOT EXISTS run_on_connect boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS script_connect_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  script_id uuid NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  execution_id uuid REFERENCES script_executions(id) ON DELETE SET NULL,
  created_at timestamp NOT NULL DEFAULT now()
);

-- One run per (script, device) — the dedup that enforces "first connect only".
CREATE UNIQUE INDEX IF NOT EXISTS script_connect_runs_script_device_unique
  ON script_connect_runs(script_id, device_id);
CREATE INDEX IF NOT EXISTS script_connect_runs_device_id_idx ON script_connect_runs(device_id);
CREATE INDEX IF NOT EXISTS script_connect_runs_org_id_idx ON script_connect_runs(org_id);

-- RLS: direct org_id (Shape 1) — standard org isolation on the device's org.
ALTER TABLE script_connect_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE script_connect_runs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON script_connect_runs;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON script_connect_runs;
DROP POLICY IF EXISTS breeze_org_isolation_update ON script_connect_runs;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON script_connect_runs;

CREATE POLICY breeze_org_isolation_select ON script_connect_runs FOR SELECT USING (
  public.breeze_has_org_access(org_id)
);
CREATE POLICY breeze_org_isolation_insert ON script_connect_runs FOR INSERT WITH CHECK (
  public.breeze_has_org_access(org_id)
);
CREATE POLICY breeze_org_isolation_update ON script_connect_runs FOR UPDATE USING (
  public.breeze_has_org_access(org_id)
) WITH CHECK (
  public.breeze_has_org_access(org_id)
);
CREATE POLICY breeze_org_isolation_delete ON script_connect_runs FOR DELETE USING (
  public.breeze_has_org_access(org_id)
);
