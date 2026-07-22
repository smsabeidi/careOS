-- ST-003 · Migration 0007 — explicit function-privilege lockdown (D-011)
-- The 0001 ALTER DEFAULT PRIVILEGES turned out not to bind for functions created
-- by the migration runner (verified by pgTAP 001: authenticated could still call
-- app.emit_audit). Defaults are role-specific and fragile; this migration makes the
-- callable surface explicit and final: revoke everything, then re-grant exactly the
-- helper set and the Lane-B RPC catalog. pgTAP 001_schema_invariants enforces this
-- shape from now on — any future function that leaks EXECUTE fails CI.
-- @trace: ST-003

revoke all on all functions in schema app from public, anon, authenticated;
revoke all on all functions in schema audit from public, anon, authenticated, service_role;

-- Policy helpers (evaluated with invoker privileges inside RLS policies):
grant execute on function
  app.current_user_id(), app.current_tenant_id(), app.is_aal2(),
  app.has_perm(text), app.on_care_team(uuid)
to authenticated;

-- Lane-B RPC catalog:
grant execute on function app.create_form(uuid, uuid, jsonb) to authenticated;
grant execute on function app.save_draft(uuid, jsonb, uuid) to authenticated;
grant execute on function app.finalize_form(uuid, uuid) to authenticated;
grant execute on function app.correct_form(uuid, jsonb, text) to authenticated;
grant execute on function app.sign_version(uuid, text) to authenticated;

-- System emission path (workers/agents only):
grant execute on function app.emit_audit_system(uuid, text, text, text, uuid, jsonb) to service_role;

-- app.emit_audit, app.forbid_mutation, audit.compute_chain, audit.verify_chain:
-- deliberately no grants to any client-facing role.
