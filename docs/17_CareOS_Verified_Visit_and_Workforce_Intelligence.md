# 17 — CareOS Verified Visit & Workforce Intelligence

**Status:** v1.0 · **Owner:** Eng · **Ratified by:** D-022…D-030 (docs/00 §3) · **Supersedes:** nothing; extends docs/07 §6, docs/08 §3/§6.1, docs/09 §6, docs/10 §6, docs/16 §2

This document is both the **specification** and the **build contract** for the Verified Visit &
Workforce Intelligence layer. Every table, column, function signature, permission key, error code
and file path used by the implementation is pinned here. Where the board proposal
(*"careOS Verified Visit & Workforce Intelligence", August 2026*) and the ratified corpus diverge,
this document records which one won and why.

---

## 1. What this layer is

One trusted operational record joining **who was supposed to provide care**, **who actually did**,
**where**, **when**, **what service**, **how long**, and **whether anything abnormal happened** —
and everything downstream that record can power: EVV, attendance, timesheets, approved hours,
payroll, exception management, fraud evidence, and workforce intelligence.

It is a platform service, not a screen. The caregiver sees two buttons. The database does the rest.

### 1.1 The two-engine rule (invariant 13, restated for this layer)

| Deterministic — SQL/PostGIS/policy engine | Probabilistic — the AI layer |
|---|---|
| Is this point inside the geofence? | Why does this caregiver keep running late on Mondays? |
| How many minutes were worked? | Which 3 of these 100 exceptions matter most today? |
| Do these two visits overlap? | Write the weekly operations narrative |
| Was the arrival late under policy? | Draft the outreach to a caregiver with a missing clock-out |
| Is this travel physically possible? | Summarise payroll readiness for the administrator |
| Are the six EVV elements present? | Explain an anomaly in plain language |

No LLM ever decides a fact in the left column. The AI layer reads the left column's output and
explains, ranks, and drafts. Enforced structurally: every AI capability in §11 is registered with a
tier and consumes only the aggregate feature set from §10 — never raw GPS.

---

## 2. Decisions this layer required

Full text in docs/00 §3. Summary of what was ratified to unblock the build:

| # | Decision | Effect on this build |
|---|---|---|
| D-022 | **Web is the caregiver EVV surface**; the phantom "no native mobile app" claim in migration 0013's header is retro-ratified, D-003/PowerSync narrowed to a future-optional lane | Clock-in is a browser Geolocation capture through a Lane-B RPC; offline is a PWA queue (§7.6), not PowerSync |
| D-023 | **`visit` = the scheduled care event; `shift` = the caregiver roster window** (0011's naming wins over docs/07 §6's) | EVV columns attach additively to `public.visit`; no second visit table |
| D-024 | **Verification, approval, payroll and EVV are four orthogonal state axes**, not one 19-state enum | Four independent columns on `visit`, each a projection of an append-only ledger |
| D-025 | **Address normalisation is deterministic and in-database; geocoding is a human-verified or adapter-supplied input**. No geocoding vendor is added | `service_location_version` carries `geo` + provenance; the vendor seam exists, disabled, until a BAA-eligible provider is registered |
| D-026 | **The EVV canonical model is state-agnostic; adapters translate.** Maryland ships in `reconcile` mode, which is correct under both an open and a closed state model | V17 no longer blocks the build — only the flip of one adapter row |
| D-027 | **Approved hours land in Phase 1; the payroll *ledger* is internal and export-only** | `approved_work_segment` + `payroll_period` + CSV export. No payroll vendor, no accounting book of record |
| D-028 | **Trust score is deterministic evidence, never an automated adverse action** | Score is computed in SQL; any employee-adverse use is T2/T3 with a human disposer |
| D-029 | **`app.clock_visit` is re-signed** (drop + create with defaulted new parameters) | Old 5-arg call sites keep working; new capture fields are additive |
| D-030 | **Location data is PHI-by-linkage**, capture points are enumerated and closed | Coordinates never enter audit payloads, notifications, telemetry, or prompts |

### 2.1 Where the board proposal was overridden

1. **REST endpoints → Lane-B RPCs.** The proposal's `POST /visits/:id/clock-in` violates docs/08 §1,
   which makes Postgres RPCs the only lane that changes consequential state. Same contract, right lane.
2. **`previous_event_hash` → the existing audit chain.** careOS already has a per-tenant hash chain
   (`audit.compute_chain`, D-011). A second, weaker tamper-evidence mechanism on one table would be
   duplicated infrastructure with none of the chain's guarantees.
3. **19-state enum → four orthogonal axes** (D-024). A single enum cannot express "verified but
   unapproved" or "approved but EVV-rejected", both of which are ordinary daily states.
4. **Google Address Validation → deterministic normaliser + adapter seam** (D-025). Google Maps
   Platform is not a BAA-eligible service; patient addresses are PHI. Shipping a disabled seam is the
   permanent fix; shipping the vendor would be a HIPAA finding.
5. **Continuous "location confidence" scoring of people → per-event location status.** The proposal's
   `SUSPICIOUS` status is retained but is a *rule outcome with evidence*, never a vibe.

---

## 3. Data model

Naming per docs/07 §1 (singular snake_case). `[AO]` = append-only (`app.forbid_mutation` trigger,
no UPDATE/DELETE grant). All tables: `tenant_id` first-class, RLS enabled **and** forced, explicit
grants, entry in `supabase/tests/database/matrix.yaml`.

### 3.1 `public.service_type` — the "type of service" EVV element

```
id uuid pk                       tenant_id uuid not null → tenant(id)
code text not null               -- 'PCA','CNA','RN_SUPERVISORY','COMPANION'
name text not null
evv_required boolean not null default false
payer_kind text not null default 'private'
    check (payer_kind in ('medicaid','medicare','private','waiver','other'))
billable boolean not null default true
active boolean not null default true
created_at, updated_at, row_version
unique (tenant_id, code)
```
RLS: read = any tenant member; write = `schedule.write`. Not PHI (catalog).

### 3.2 `public.service_location` — identity of a place of care

```
id uuid pk                       tenant_id uuid not null → tenant(id)
client_id uuid not null → client(id)
kind text not null check (kind in
  ('primary_residence','temporary_residence','family_residence','community','facility','alternate'))
label text                       -- 'Home', 'Daughter's house'
is_primary boolean not null default false
effective_from date not null default current_date
effective_until date
current_version_id uuid          -- → service_location_version(id), set by RPC
active boolean not null default true
created_by uuid not null → app_user(id)
created_at, updated_at, row_version
```
PHI (a client's address). RLS: `app.is_aal2()` **and** (`app.on_care_team(client_id)` or
`app.has_perm('location.manage')` or assigned caregiver on a visit at this location).
No direct write grants — RPC only (§6.1).

### 3.3 `public.service_location_version` — [AO] the geographic source of truth

Follows the `form_template`/`form_version` binding precedent (D-014): a verified visit binds to the
exact version it was verified against, so editing an address can never rewrite history.

```
id uuid pk                       tenant_id uuid not null
service_location_id uuid not null → service_location(id)
version_no int not null                             -- server-assigned, 1-based
original_address text not null                      -- exactly as entered
normalized_address text not null                    -- app.normalize_address()
address_line1 text, address_line2 text, city text, state text,
postal_code text, country text not null default 'US'
geo extensions.geography(Point,4326)                -- NULL ⇒ unlocatable, see precision
geo_precision text not null default 'unknown' check (geo_precision in
  ('rooftop','parcel','interpolated','street','locality','manual','unknown'))
geo_source text not null default 'manual' check (geo_source in
  ('manual','import','provider','derived'))
geo_provider text                                   -- NULL unless an adapter supplied it
geo_provider_place_id text
geo_provider_response_sha256 text                   -- provenance, never the raw response
verification text not null default 'unverified'
  check (verification in ('unverified','verified','rejected'))
verified_by uuid → app_user(id)                     -- human attestation (D-025)
verified_at timestamptz
geofence_radius_m int check (geofence_radius_m between 25 and 5000)  -- NULL ⇒ policy default
supersedes_id uuid → service_location_version(id)
change_reason text
created_by uuid not null → app_user(id)
created_at timestamptz not null default now()
unique (service_location_id, version_no)
constraint chk_slv_verified_needs_human
  check (verification <> 'verified' or (verified_by is not null and verified_at is not null))
```
Index: `gist (geo)` where geo is not null. PHI. Read follows the parent; **no write grants**.

### 3.4 `public.visit_policy` — [AO] the policy engine

Resolution order (most specific wins, field-by-field merge):
`client → service_type → payer_kind → program → tenant`.

```
id uuid pk                       tenant_id uuid not null
scope_kind text not null check (scope_kind in
  ('tenant','program','payer_kind','service_type','client'))
scope_id uuid                    -- NULL for tenant/payer_kind scopes
scope_value text                 -- payer_kind value when scope_kind='payer_kind'
version_no int not null
effective_from timestamptz not null default now()
effective_until timestamptz
-- geofence
geofence_tier text not null default 'standard'
  check (geofence_tier in ('strict','standard','rural','custom'))
geofence_radius_m int not null default 200 check (geofence_radius_m between 25 and 5000)
max_accuracy_m int not null default 250 check (max_accuracy_m between 10 and 5000)
require_clock_in_location boolean not null default true
require_clock_out_location boolean not null default true
allow_location_exception boolean not null default true
-- time
early_clock_in_minutes int not null default 15
late_threshold_minutes int not null default 7
clock_out_grace_minutes int not null default 10
missing_clock_out_minutes int not null default 20
missed_visit_minutes int not null default 60
max_visit_minutes int not null default 900
-- documentation
require_visit_note boolean not null default false
require_task_completion boolean not null default false
signature_requirement text not null default 'none' check (signature_requirement in
  ('none','optional','required_for_service','required_for_payer'))
-- money
rounding_policy text not null default 'none' check (rounding_policy in
  ('none','nearest_1','nearest_5','nearest_6','nearest_15'))
overtime_weekly_minutes int not null default 2400          -- 40h
-- fraud
impossible_travel_kmh int not null default 120
supersedes_id uuid → visit_policy(id)
change_reason text
created_by uuid not null → app_user(id)
created_at timestamptz not null default now()
unique (tenant_id, scope_kind, scope_id, scope_value, version_no)
```
Not PHI. Read: any tenant member (caregivers must see their own grace periods).
Write: RPC only, `policy.manage`.

> **Tier values are engineering defaults, not regulatory thresholds.** `strict` 75–150 m,
> `standard` 150–300 m, `rural` 300–750 m. No COMAR or federal rule sets a radius; agencies do.

### 3.5 `public.visit` — additive columns (expand phase)

```
service_type_id uuid → service_type(id)
service_location_id uuid → service_location(id)
service_location_version_id uuid → service_location_version(id)   -- bound at clock-in
policy_id uuid → visit_policy(id)                                 -- resolved policy, bound at clock-in
verification_status text not null default 'pending'
  check (verification_status in ('pending','verified','exception','manual_review'))
approval_status text not null default 'pending'
  check (approval_status in ('pending','approved','rejected'))
payroll_status text not null default 'not_ready'
  check (payroll_status in ('not_ready','ready','exported'))
evv_status text not null default 'not_required'
  check (evv_status in ('not_required','pending','submitted','accepted','rejected','reconciled'))
```
**Privilege tightening (deliberate):** table-wide `UPDATE` on `public.visit` is revoked from
`authenticated` and re-granted column-by-column for the scheduling columns only
(`caregiver_id, shift_id, scheduled_start, scheduled_end, status, note, service_type_id,
service_location_id, updated_at, row_version`). The four projection columns and the two binding
columns are writable **only** by definer RPCs. Asserted in pgTAP.

### 3.6 `public.visit_event` — [AO] extension of the existing ledger

Existing columns keep their meaning. `event_type` CHECK widens (expand-safe) to:
`clock_in, clock_out, clock_in_rejected, clock_out_rejected, exception_requested, correction`.

New columns:
```
client_event_id text                       -- caller-supplied idempotency key
client_captured_at timestamptz             -- DEVICE time; diagnostics only, never authoritative
received_at timestamptz not null default now()
service_location_version_id uuid → service_location_version(id)
policy_id uuid → visit_policy(id)
distance_m double precision                -- to the bound service location
location_status text check (location_status in
  ('verified','low_accuracy','outside_geofence','unavailable','suspicious','not_required'))
capture_source text not null default 'web'
  check (capture_source in ('web','offline','manual','system'))
is_offline boolean not null default false
device_session_id text                     -- opaque, rotating; not a device fingerprint
reason_code text check (reason_code in
  ('alternate_location','gps_unavailable','address_incorrect','emergency_visit',
   'device_issue','network_failure','other'))
corrects_event_id uuid → visit_event(id)   -- corrections reference, never overwrite
```
`unique (tenant_id, visit_id, client_event_id)` where `client_event_id is not null`.
`method` keeps its existing `('web','manual')` CHECK; `capture_source` is the finer-grained field.

**Server time is authoritative.** `occurred_at` defaults to `now()` and the RPC never accepts a
caller-supplied value for it. `client_captured_at` is stored for drift diagnostics and is surfaced
to administrators as evidence, never used for payroll or EVV maths.

### 3.7 `public.visit_exception` — [AO] detected exceptions

```
id uuid pk                       tenant_id uuid not null
visit_id uuid not null → visit(id)
caregiver_id uuid → app_user(id)
kind text not null check (kind in (
  'location_unverified','low_accuracy','outside_geofence','location_unavailable',
  'late_start','early_end','long_visit','short_visit','missing_clock_out','missed_visit',
  'overlapping_visits','impossible_travel','manual_correction','duplicate_visit',
  'evv_rejected','payroll_mismatch','documentation_missing'))
severity text not null default 'info' check (severity in ('info','warning','critical'))
detected_by text not null default 'rule' check (detected_by in ('rule','human','agent'))
rule_key text                                  -- 'sweep.missing_clock_out'
dedupe_key text not null                       -- idempotent sweeps
evidence jsonb not null default '{}'::jsonb    -- IDs + numbers ONLY (invariant 5)
source_event_id uuid → visit_event(id)
created_by uuid → app_user(id)
created_at timestamptz not null default now()
unique (tenant_id, visit_id, kind, dedupe_key)
```

### 3.8 `public.visit_exception_disposition` — [AO] how a human resolved it

```
id uuid pk · tenant_id · exception_id → visit_exception(id)
disposition text not null check (disposition in
  ('acknowledged','resolved','dismissed','escalated','reopened'))
reason text not null
acted_by uuid not null → app_user(id)          -- ALWAYS a human (kind='staff' enforced)
created_at timestamptz not null default now()
```
Current state = latest disposition, exposed via `public.visit_exception_state` view.

### 3.9 `public.visit_trust_assessment` — [AO] deterministic score snapshots

```
id · tenant_id · visit_id → visit(id)
score int not null check (score between 0 and 100)
band text not null check (band in
  ('verified','verified_with_exception','requires_review','high_risk'))
components jsonb not null      -- {location:35,time:20,schedule:15,identity:15,device:10,consistency:5}
reasons jsonb not null         -- [{code,detail_id}] — codes + IDs, never prose about a person
model_version text not null    -- 'trust.v1' — the weight set that produced this
computed_at timestamptz not null default now()
```

### 3.10 `public.approved_work_segment` — [AO] the payroll boundary

```
id · tenant_id · visit_id → visit(id) · caregiver_id → app_user(id)
work_date date not null
verified_minutes int not null check (verified_minutes >= 0)   -- from the ledger, immutable fact
approved_minutes int not null check (approved_minutes >= 0)   -- what a human approved
rounding_applied text not null default 'none'
pay_code text not null default 'regular'
  check (pay_code in ('regular','overtime','holiday','training','travel','adjustment'))
approval_note text
approved_by uuid not null → app_user(id)
supersedes_id uuid → approved_work_segment(id)   -- corrections create a new segment
created_at timestamptz not null default now()
```

### 3.11 `public.payroll_period` / `public.payroll_export` — [AO]

```
payroll_period: id · tenant_id · starts_on date · ends_on date · status
  check (status in ('open','locked','exported')) · locked_by · locked_at · unique(tenant_id,starts_on,ends_on)
payroll_export: id · tenant_id · period_id · format ('csv') · row_count int · total_minutes int
  · content_sha256 text not null · exported_by · exported_at · [AO]
```
`payroll_period.status` is the only mutable field, RPC-only.

### 3.12 `public.evv_record` — [AO] the canonical, state-agnostic EVV object

The six federally required elements, named for what they are:

```
id · tenant_id · source_visit_id → visit(id)
service_type_id → service_type(id)          -- (1) type of service
client_id → client(id)                      -- (2) individual receiving service
service_date date not null                  -- (3) date of service
service_location_version_id → service_location_version(id)   -- (4) location
caregiver_id → app_user(id)                 -- (5) individual providing service
start_at timestamptz not null               -- (6a) begin time
end_at timestamptz not null                 -- (6b) end time
capture_method text not null default 'web_gps'
  check (capture_method in ('web_gps','manual','offline_sync','telephony','corrected'))
exception_code text
payer_kind text not null
element_completeness jsonb not null         -- {service_type:true,…} deterministic check
is_complete boolean not null                -- all six present
record_sha256 text not null                 -- canonical hash; resubmissions reference it
supersedes_id uuid → evv_record(id)
created_at timestamptz not null default now()
```

### 3.13 `public.evv_adapter` + `public.evv_submission` — [AO submissions]

```
evv_adapter: id · tenant_id · target text ('isas','sandata','hhax','none')
  · state_code text ('MD') · mode text check (mode in ('capture','reconcile','dual','disabled'))
  · enabled boolean not null default false · adapter_version text · config jsonb (NON-SECRET only)
  · unique (tenant_id, target, state_code)

evv_submission: id · tenant_id · evv_record_id → evv_record(id) · adapter_id → evv_adapter(id)
  · attempt_no int not null · status text check (status in
    ('pending','submitted','accepted','rejected','superseded','reconciled'))
  · external_reference text · response_code text · response_message text   -- vendor codes, no PHI
  · request_sha256 text · submitted_at · resolved_at · created_at   [AO]
```
Maryland ships as `('isas','MD', mode='reconcile', enabled=false)`. **This is correct under both
answers to V17**: in a closed model CareOS reconciles against ISAS as system of record; in an open
model the same canonical record flips to `mode='capture'` with one row update and an adapter
implementation. The build is not blocked on the answer (D-026).

---

## 4. Deterministic engine — function contracts

All are `security definer`, `set search_path`, `revoke all … from public, anon`, and granted only
where §5 says. All money/time/geo maths lives here. Return shapes are jsonb.

### 4.1 Geo primitives (migration 0043)
```
app.normalize_address(p_line1 text, p_line2 text, p_city text, p_state text,
                      p_postal text, p_country text default 'US') returns text
    -- deterministic: uppercase, collapse whitespace, USPS suffix + directional folding
    -- ('AVENUE'→'AVE','NORTH'→'N'), unit designator folding, punctuation strip. IMMUTABLE.
app.geo_point(p_lat double precision, p_lng double precision) returns extensions.geography
    -- NULL on out-of-range; validates lat ∈ [-90,90], lng ∈ [-180,180]. IMMUTABLE.
app.distance_m(p_geo extensions.geography, p_lat, p_lng) returns double precision
```

### 4.2 Policy resolution (0044)
```
app.resolve_visit_policy(p_client uuid, p_service_type uuid default null,
                         p_at timestamptz default now()) returns public.visit_policy
app.visit_policy_for(p_visit uuid) returns public.visit_policy
```
Field-by-field merge, most specific non-null wins, tenant row is the floor. Deterministic and
`stable`. If no tenant-scope row exists → `CAREOS_POLICY_MISSING`.

### 4.3 Location confidence (0046) — the exact rule, and nothing else
```
app.evaluate_location(p_accuracy_m double precision, p_distance_m double precision,
                      p_max_accuracy_m int, p_radius_m int) returns text
```
```
IF distance IS NULL OR accuracy IS NULL          → 'unavailable'
ELSIF accuracy > max_accuracy_m                  → 'low_accuracy'
ELSIF distance <= radius_m                       → 'verified'
ELSE                                             → 'outside_geofence'
```
`suspicious` is **never** produced here — it is only ever set by a §4.5 rule with evidence.
Pure, `immutable`, and unit-tested against the table in docs/12 §4.

### 4.4 The clock RPC (0046)
```
app.clock_visit(
  p_visit uuid,
  p_event text,                                  -- 'clock_in' | 'clock_out'
  p_lat double precision default null,
  p_lng double precision default null,
  p_accuracy double precision default null,
  p_client_event_id text default null,
  p_captured_at timestamptz default null,        -- device time, diagnostics only
  p_offline boolean default false,
  p_reason_code text default null,
  p_note text default null,
  p_device_session_id text default null
) returns jsonb
```
Behaviour, in order:
1. `app.is_aal2()` else `CAREOS_AAL2_REQUIRED`.
2. Visit exists in tenant else `CAREOS_NOT_FOUND`; caller is the assigned caregiver else
   `CAREOS_FORBIDDEN`.
3. **Idempotent replay:** if `p_client_event_id` matches an existing event → return that event with
   `replayed: true`. Never a second row, never an error.
4. Sequence guard: `clock_in` when already clocked in → `CAREOS_ALREADY_CLOCKED_IN`;
   `clock_out` with no open clock-in → `CAREOS_NOT_CLOCKED_IN`.
5. Resolve policy + service location version; bind both to the visit on first clock-in.
6. Compute distance and `location_status`.
7. Decide:
   - `verified` → append `clock_in`/`clock_out`.
   - not verified **and** policy allows exception **and** a `reason_code` was supplied → append the
     event with the status, and raise the matching `visit_exception`.
   - not verified **and** policy allows exception **and** no reason yet → append
     `clock_in_rejected`, return `{ok:false, needs_reason:true, location_status:…}`. The UI then
     offers "Try again" / "Request exception". **No exception is raised for a retry.**
   - not verified **and** policy forbids exception → append `*_rejected`, raise
     `CAREOS_GEOFENCE_UNVERIFIED`.
8. Advance `visit.status` (`scheduled→in_progress`, `in_progress→completed`) and set
   `verification_status`.
9. Emit audit (IDs + enums only, **never coordinates**) and an outbox domain event.

Returns `{ok, replayed, event_id, status, verification_status, location_status, occurred_at,
needs_reason, distance_bucket}`. **`distance_bucket`** (`'inside'|'near'|'far'`) is returned instead
of metres so the caregiver UI can be helpful without ever displaying surveillance-grade precision.

### 4.5 Exception detection (0047) — pure SQL, scheduled
```
app.detect_missing_clock_out(p_now timestamptz default now())   returns int
app.detect_missed_visits(p_now timestamptz default now())       returns int
app.detect_overlapping_visits(p_visit uuid default null)        returns int
app.detect_impossible_travel(p_visit uuid default null)         returns int
app.detect_documentation_gaps(p_visit uuid default null)        returns int
app.sweep_visit_exceptions(p_now timestamptz default now())     returns jsonb
```
Each is idempotent via `dedupe_key`, returns the number of NEW exceptions raised, and is safe to run
concurrently. `sweep_visit_exceptions` is the cron entry point (0034 pattern, every 5 minutes) and
returns per-rule counts. Clock injection (`p_now`) makes temporal correctness testable — the D-016
precedent.

**Impossible travel** uses PostGIS: for consecutive clock events by one caregiver,
`speed_kmh = distance_m / 1000 / (interval_hours)`; flag when `speed_kmh > policy.impossible_travel_kmh`
and the interval is > 60 s (avoids divide-by-noise on same-minute events).

**Overlap** is `tstzrange(actual_start, actual_end) && tstzrange(...)` per caregiver, and separately
per client — both are exceptions, with different `kind`s only if they differ operationally.

### 4.6 Corrections (0047)
```
app.correct_visit_event(p_event uuid, p_occurred_at timestamptz, p_reason text) returns jsonb
```
Appends a `correction` event with `corrects_event_id` set. The original is never touched. Requires
`visit.correct`, AAL2, and a non-empty reason. Emits audit with old→new **timestamps** (not PHI) and
raises a `manual_correction` exception so the correction itself is reviewable.

### 4.7 Approval and payroll (0050)
```
app.approve_visit_hours(p_visit uuid, p_approved_minutes int default null,
                        p_pay_code text default 'regular', p_note text default null) returns jsonb
app.reject_visit_hours(p_visit uuid, p_reason text) returns jsonb
app.compute_visit_minutes(p_visit uuid) returns jsonb   -- verified/scheduled/late/overrun, rounded
app.compute_overtime(p_caregiver uuid, p_week_start date) returns jsonb
app.close_payroll_period(p_period uuid) returns jsonb
app.export_payroll_period(p_period uuid) returns jsonb  -- returns rows + content_sha256
```
`approve_visit_hours` refuses when the visit is not `completed`, when an unresolved `critical`
exception exists (`CAREOS_APPROVAL_BLOCKED`), or when the actor is the caregiver themself
(self-approval is structurally impossible — asserted in pgTAP).

### 4.8 EVV (0049)
```
app.build_evv_record(p_visit uuid) returns jsonb      -- canonicalises + hashes + completeness
app.submit_evv(p_visit uuid) returns jsonb            -- enqueues; no-op when adapter disabled
app.reconcile_evv(p_submission uuid, p_status text, p_external_reference text,
                  p_response_code text, p_response_message text) returns jsonb  -- worker only
```

### 4.9 Trust score (0048)
```
app.visit_trust_score(p_visit uuid) returns jsonb     -- computes, does not store
app.record_trust_assessment(p_visit uuid) returns uuid -- computes + appends a snapshot
```
Weights (`trust.v1`): location 35, time 20, schedule 15, identity 15, device 10, consistency 5.
Bands: ≥90 `verified`, ≥75 `verified_with_exception`, ≥50 `requires_review`, else `high_risk`.

---

## 5. Permissions (new keys, inserted into `public.permission`)

| Key | Grants |
|---|---|
| `location.manage` | Create/edit service locations and verify geocodes |
| `policy.manage` | Author visit policies |
| `visit.verify.read` | See the exception queue and verification detail |
| `visit.verify.act` | Dispose exceptions |
| `visit.correct` | Append clock corrections |
| `visit.approve` | Approve/reject visit hours |
| `payroll.read` | Read timesheets and payroll readiness |
| `payroll.manage` | Close periods and export |
| `evv.read` | Read EVV records and submissions |
| `evv.manage` | Configure adapters, trigger submission/reconciliation |
| `workforce.read` | Workforce analytics surfaces |

Caregivers need **no** new permission to clock: the RPC authorises on assignment, as it does today.

---

## 6. Write paths (Lane-B RPC catalog additions, docs/08 §3)

### 6.1 Service locations
```
app.create_service_location(p_client uuid, p_kind text, p_label text, p_address jsonb,
                            p_is_primary boolean default false) returns jsonb
app.revise_service_location(p_location uuid, p_address jsonb, p_reason text) returns jsonb
app.verify_service_location(p_version uuid, p_lat double precision, p_lng double precision,
                            p_precision text, p_note text default null) returns jsonb
app.set_service_location_geofence(p_version uuid, p_radius_m int, p_reason text) returns jsonb
```
`p_address` = `{line1,line2,city,state,postal_code,country}`. `revise_*` always writes a new
version with `supersedes_id`; nothing is ever edited in place.

### 6.2 Policies
```
app.upsert_visit_policy(p_scope_kind text, p_scope_id uuid, p_scope_value text,
                        p_settings jsonb, p_reason text) returns jsonb   -- appends a new version
```

### 6.3 Exceptions
```
app.raise_visit_exception(p_visit uuid, p_kind text, p_severity text,
                          p_evidence jsonb, p_dedupe_key text) returns jsonb   -- system/internal
app.request_location_exception(p_visit uuid, p_event text, p_reason_code text,
                               p_note text) returns jsonb                       -- caregiver
app.dispose_visit_exception(p_exception uuid, p_disposition text, p_reason text) returns jsonb
```

---

## 7. Surfaces

### 7.1 Caregiver — `/today` (existing, extended)
Two actions. Ever. `Clock In` → `Clocked in · 9:02 AM · Visit in progress` → `Complete Visit`.
Copy rules (docs/10 voice): never the words *EVV*, *geofence*, *GPS accuracy*, *radius*, or any
coordinate. The failure string is **"We couldn't verify your location yet."** with `Try again` and,
where policy allows, `Request exception`.

### 7.2 Admin — `/operations`
- `/operations` — live board: active / completed / late / exceptions / missed counters + the day's visit table.
- `/operations/exceptions` — the exception inbox, ranked (deterministic urgency, AI narration).
- `/operations/attendance` — scheduled-vs-actual per caregiver.
- `/operations/timesheets` — approve hours; period close; export.
- `/operations/evv` — canonical records, submissions, reconciliation state.
- `/operations/workforce` — the intelligence surface.
- `/clients/[id]/locations` — service locations, geocode verification, per-location geofence.
- `/settings/visit-policy` — the policy editor with an inheritance preview.

### 7.3 The four-state doctrine applies to every one of them (docs/10). No screen ships without
loading, empty, error and content states, and each is exercised in a Playwright journey (§12).

### 7.6 Offline (PWA)
Service worker + IndexedDB queue. A queued clock action carries a client-generated
`client_event_id` (UUIDv4) and `client_captured_at`; on reconnect it replays through the same RPC.
Idempotency makes replay safe by construction. Offline events are flagged `is_offline=true` and
`capture_source='offline'`, are **never** presented as ordinarily verified, and are routed through
`app.detect_*` like any other event. The UI shows `Live / Syncing (n) / Offline` per docs/10 §6.

---

## 8. Events (outbox, migration 0027 pattern)

`visit.clock_in.verified`, `visit.clock_in.exception`, `visit.clock_out.completed`,
`visit.at_risk`, `visit.missed`, `visit.corrected`, `visit.exception.raised`,
`visit.exception.disposed`, `visit.hours.approved`, `evv.record.built`, `evv.submitted`,
`evv.rejected`, `evv.accepted`, `payroll.period.closed`, `payroll.exported`.

Payloads are **IDs and enums only**. Consumers refetch under RLS (invariant 5).

---

## 9. Notifications (migration 0036 pattern) — management by exception

Nothing is sent when operations are normal. Sent: caregiver ≥ `late_threshold` with no clock-in
(caregiver first, supervisor after `missed_visit_minutes`), missing clock-out prompt to the
caregiver then the supervisor, location could not be verified, overlapping shift detected,
impossible travel detected, EVV submission rejected, payroll period blocked by unresolved
exceptions. Every payload is IDs only.

---

## 10. The AI feature set (`app.workforce_features`)

```
app.workforce_features(p_from date, p_to date, p_caregiver uuid default null) returns jsonb
```
Per caregiver, **IDs not names**, no coordinates, no free text:
`visits_scheduled, visits_completed, visits_missed, late_count, avg_late_minutes,
early_count, overrun_minutes, undertime_minutes, verified_rate, location_exception_count,
manual_override_count, missing_clock_out_count, overlap_count, impossible_travel_count,
documentation_missing_count, schedule_adherence_pct, overtime_minutes, client_continuity_pct,
trust_band_histogram, day_of_week_lateness[7]`.

This function is the **only** input any AI capability in §11 may read for workforce analysis.

---

## 11. AI capabilities (registered in `ai_capability`, docs/16 §2 additions)

| Key | Tier | Human disposer | Reads | Writes |
|---|---|---|---|---|
| `visit.exception_triage` | T1 | — (ranking is deterministic; AI narrates) | exception rows (IDs), §10 features | a narrative on the queue |
| `ops.daily_brief` (extend X5) | T1 | — | §10 features + counters | brief text |
| `workforce.weekly_report` | T1 | — | §10 features | report text |
| `payroll.readiness_brief` | T1 | — | aggregate hours + blocking exception counts | brief text |
| `visit.operational_profile` | **T2** | **required — Owner/HR** | §10 features for one caregiver | a draft only; never an action |
| `ops.nl_query` (extend X4) | T1 | — | grammar-constrained tools over the same views | answer text |

`visit.operational_profile` is T2 because it characterises an individual employee — invariant 8 and
D-021's "the system never proposes termination". It emits a **draft for a human**, is never
auto-delivered, and is structurally barred from writing any employment record.

Ranking for the exception queue is deterministic (severity × recency × payroll impact × client
risk); the model only writes the *why*. This is the R4 "Det+narrate" pattern from docs/16.

---

## 12. Test obligations (docs/12)

- **pgTAP per migration**: RLS matrix (every new table, every operation, every principal),
  append-only assertions, grant assertions (including the column-level `visit` tightening),
  policy resolution truth table, `evaluate_location` truth table, idempotent-replay assertion,
  self-approval refusal, sweep idempotence (running twice raises no duplicate), clock injection for
  every temporal rule.
- **Canary-PHI**: coordinates must never appear in `audit_event.payload`, notification payloads,
  outbox payloads, or any AI prompt. Asserted by a test that clocks a visit and greps every
  downstream row for the literal latitude.
- **Playwright journeys**: in-fence clock-in; out-of-fence → reason → exception; missing clock-out
  prompt; correction; approval; period close/export; four-state coverage on each new screen.
- **a11y**: axe pass on every new screen; status is never colour alone (D-012 condition).

---

## 13. Observability (docs/13)

`app.evv_observability(p_from, p_to)` → clock-in success rate, location-status distribution,
accuracy histogram (bucketed, never raw), exception rate by kind, missing-clock-out rate,
EVV acceptance rate, sweep latency — broken down by browser family, org, and service type.
**Not** by geography: a geographic breakdown of caregiver location is surveillance telemetry and is
excluded by D-030. Coordinates never leave the database.

---

## 14. Migration sequence

| # | File | Contents |
|---|---|---|
| 0043 | `0043_geo_service_location.sql` | PostGIS, `app.normalize_address`, `app.geo_point`, `app.distance_m`, `service_type`, `service_location`, `service_location_version`, §6.1 RPCs |
| 0044 | `0044_visit_policy.sql` | `visit_policy`, resolution functions, tenant defaults, `app.upsert_visit_policy` |
| 0045 | `0045_verified_visit.sql` | `visit` additive columns + column-grant tightening, `visit_event` extension, `public.verified_visit` view |
| 0046 | `0046_clock_engine.sql` | `app.evaluate_location`, re-signed `app.clock_visit`, `app.request_location_exception` |
| 0047 | `0047_exception_engine.sql` | `visit_exception`, dispositions, all `app.detect_*`, `app.sweep_visit_exceptions`, cron registration, `app.correct_visit_event` |
| 0048 | `0048_trust_score.sql` | `visit_trust_assessment`, `app.visit_trust_score` |
| 0049 | `0049_evv_canonical.sql` | `evv_record`, `evv_adapter`, `evv_submission`, builder/submit/reconcile |
| 0050 | `0050_payroll_boundary.sql` | `approved_work_segment`, `payroll_period`, `payroll_export`, approval + export RPCs |
| 0051 | `0051_workforce_analytics.sql` | `app.workforce_features`, `app.evv_observability`, supporting views |
| 0052 | `0052_visit_ai_capabilities.sql` | capability registrations, notification templates, feature flags |

Every file: header comment in the 0011/0013 idiom (title, decision refs, design notes, `@trace`),
matching `supabase/tests/database/00NN_*.sql`, and a `matrix.yaml` entry per new table.
