# CareOS — RLS policy catalog

**GENERATED FILE — do not edit by hand.** Regenerate with `bash scripts/gen-policies.sh`.
Introspected from `pg_policies` on a database with the full migration chain applied,
so this is the policy set Postgres *enforces*, not the one the migration text implies.

`106` policies across `71` tables. `5` further RLS-enabled tables
carry no policy at all and are therefore deny-by-default (listed at the end).

RLS is the perimeter (invariant 2): app code is convenience, Postgres authorizes.
Every PHI policy must carry `app.is_aal2()` (invariant 3) and pin
`tenant_id = app.current_tenant_id()` as a top-level conjunct.

## public.agent_identity

### `agent_identity_select_oversight`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND app.has_perm('ai.read'::text))` |
| WITH CHECK | `-` |


## public.agent_step

### `agent_step_insert_scoped`

| | |
|---|---|
| operation | `INSERT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `-` |
| WITH CHECK | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND (app.has_perm('schedule.write'::text) OR app.has_perm('ai.manage'::text)) AND (EXISTS ( SELECT 1  FROM agent_task t  WHERE ((t.id = agent_step.task_id) AND (t.tenant_id = app.current_tenant_id())))))` |

### `agent_step_select_scoped`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND (EXISTS ( SELECT 1  FROM agent_task t  WHERE ((t.id = agent_step.task_id) AND (t.tenant_id = app.current_tenant_id()) AND (app.has_perm('ai.read'::text) OR app.has_perm('schedule.read'::text) OR app.has_perm('schedule.write'::text) OR (t.created_by = auth.uid()))))))` |
| WITH CHECK | `-` |


## public.agent_task

### `agent_task_insert_self`

| | |
|---|---|
| operation | `INSERT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `-` |
| WITH CHECK | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND (created_by = auth.uid()) AND (app.has_perm('schedule.write'::text) OR app.has_perm('ai.manage'::text)))` |

### `agent_task_select_scoped`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND (app.has_perm('ai.read'::text) OR app.has_perm('schedule.read'::text) OR app.has_perm('schedule.write'::text) OR (created_by = auth.uid())))` |
| WITH CHECK | `-` |

### `agent_task_update_status`

| | |
|---|---|
| operation | `UPDATE` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND (app.has_perm('schedule.write'::text) OR app.has_perm('ai.manage'::text) OR (created_by = auth.uid())))` |
| WITH CHECK | `(tenant_id = app.current_tenant_id())` |


## public.ai_capability

### `ai_capability_select_tenant`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `(tenant_id = app.current_tenant_id())` |
| WITH CHECK | `-` |


## public.ai_disposition

### `ai_disposition_insert_self`

| | |
|---|---|
| operation | `INSERT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `-` |
| WITH CHECK | `((tenant_id = app.current_tenant_id()) AND (disposed_by = auth.uid()))` |

### `ai_disposition_select_scoped`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND ((disposed_by = auth.uid()) OR app.has_perm('ai.read'::text)))` |
| WITH CHECK | `-` |


## public.ai_interaction

### `ai_interaction_insert_self`

| | |
|---|---|
| operation | `INSERT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `-` |
| WITH CHECK | `((tenant_id = app.current_tenant_id()) AND (created_by = auth.uid()))` |

### `ai_interaction_select_scoped`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND ((created_by = auth.uid()) OR app.has_perm('ai.read'::text)))` |
| WITH CHECK | `-` |


## public.ai_prompt_template

### `ai_prompt_template_select_tenant`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `(tenant_id = app.current_tenant_id())` |
| WITH CHECK | `-` |


## public.ai_proposal

### `ai_proposal_insert_self`

| | |
|---|---|
| operation | `INSERT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `-` |
| WITH CHECK | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND (created_by = auth.uid()))` |

### `ai_proposal_select_scoped`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND (app.has_perm('ai.read'::text) OR (created_by = auth.uid()) OR app.has_perm('schedule.write'::text) OR app.has_perm('compliance.read'::text)))` |
| WITH CHECK | `-` |


## public.ai_proposal_event

### `ai_proposal_event_insert_self`

| | |
|---|---|
| operation | `INSERT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `-` |
| WITH CHECK | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND (actor = auth.uid()) AND (EXISTS ( SELECT 1  FROM ai_proposal p  WHERE ((p.id = ai_proposal_event.proposal_id) AND (p.tenant_id = app.current_tenant_id()) AND (app.has_perm('ai.read'::text) OR (p.created_by = auth.uid()) OR app.has_perm('schedule.write'::text) OR app.has_perm('compliance.read'::text))))))` |

### `ai_proposal_event_select_scoped`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND (EXISTS ( SELECT 1  FROM ai_proposal p  WHERE ((p.id = ai_proposal_event.proposal_id) AND (p.tenant_id = app.current_tenant_id()) AND (app.has_perm('ai.read'::text) OR (p.created_by = auth.uid()) OR app.has_perm('schedule.write'::text) OR app.has_perm('compliance.read'::text))))))` |
| WITH CHECK | `-` |


## public.alert_ack

### `alert_ack_select_own`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND (user_id = auth.uid()))` |
| WITH CHECK | `-` |


## public.app_user

### `app_user_select_scoped`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND ((id = auth.uid()) OR app.has_perm('user.read'::text)))` |
| WITH CHECK | `-` |


## public.approved_work_segment

### `approved_work_segment_select_scoped`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND ((caregiver_id = auth.uid()) OR app.has_perm('visit.approve'::text) OR app.has_perm('payroll.read'::text) OR app.has_perm('payroll.manage'::text)))` |
| WITH CHECK | `-` |


## public.cadence_rule

### `cadence_rule_select_tenant`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `(tenant_id = app.current_tenant_id())` |
| WITH CHECK | `-` |


## public.care_plan

### `care_plan_insert_scoped`

| | |
|---|---|
| operation | `INSERT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `-` |
| WITH CHECK | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND (authored_by = auth.uid()) AND (app.has_perm('form.write.all'::text) OR app.on_care_team(client_id)) AND (EXISTS ( SELECT 1  FROM client c  WHERE ((c.id = care_plan.client_id) AND (c.tenant_id = app.current_tenant_id())))))` |

### `care_plan_select_scoped`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND (app.has_perm('client.read.all'::text) OR app.on_care_team(client_id)))` |
| WITH CHECK | `-` |


## public.care_plan_item

### `care_plan_item_insert_scoped`

| | |
|---|---|
| operation | `INSERT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `-` |
| WITH CHECK | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND (EXISTS ( SELECT 1  FROM care_plan cp  WHERE ((cp.id = care_plan_item.care_plan_id) AND (cp.tenant_id = app.current_tenant_id()) AND (app.has_perm('form.write.all'::text) OR app.on_care_team(cp.client_id))))))` |

### `care_plan_item_select_scoped`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND (EXISTS ( SELECT 1  FROM care_plan cp  WHERE ((cp.id = care_plan_item.care_plan_id) AND (app.has_perm('client.read.all'::text) OR app.on_care_team(cp.client_id))))))` |
| WITH CHECK | `-` |


## public.care_team_assignment

### `cta_select_scoped`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND ((user_id = auth.uid()) OR app.has_perm('careteam.read'::text)))` |
| WITH CHECK | `-` |


## public.client

### `client_insert_admin`

| | |
|---|---|
| operation | `INSERT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `-` |
| WITH CHECK | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND app.has_perm('client.write'::text))` |

### `client_select_scoped`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND (app.has_perm('client.read.all'::text) OR app.on_care_team(id)))` |
| WITH CHECK | `-` |

### `client_update_admin`

| | |
|---|---|
| operation | `UPDATE` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND app.has_perm('client.write'::text))` |
| WITH CHECK | `(tenant_id = app.current_tenant_id())` |


## public.clinical_flag

### `clinical_flag_insert_scoped`

| | |
|---|---|
| operation | `INSERT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `-` |
| WITH CHECK | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND (created_by = auth.uid()) AND (app.on_care_team(client_id) OR app.has_perm('client.read.all'::text)))` |

### `clinical_flag_select_scoped`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND (app.on_care_team(client_id) OR app.has_perm('client.read.all'::text)))` |
| WITH CHECK | `-` |

### `clinical_flag_update_disposition`

| | |
|---|---|
| operation | `UPDATE` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND app.has_perm('client.read.all'::text))` |
| WITH CHECK | `((tenant_id = app.current_tenant_id()) AND ((acknowledged_by IS NULL) OR (acknowledged_by = auth.uid())))` |


## public.consent

### `consent_insert_staff`

| | |
|---|---|
| operation | `INSERT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `-` |
| WITH CHECK | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND (recorded_by = auth.uid()) AND (app.has_perm('family.manage'::text) OR app.on_care_team(client_id)) AND (EXISTS ( SELECT 1  FROM client c  WHERE ((c.id = consent.client_id) AND (c.tenant_id = app.current_tenant_id())))))` |

### `consent_select_scoped`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND (app.has_perm('client.read.all'::text) OR app.on_care_team(client_id) OR app.on_family_link(client_id, NULL::text)))` |
| WITH CHECK | `-` |


## public.credential

### `credential_insert_admin`

| | |
|---|---|
| operation | `INSERT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `-` |
| WITH CHECK | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND app.has_perm('credential.write'::text))` |

### `credential_select_scoped`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND (app.has_perm('credential.read.all'::text) OR (app_user_id = auth.uid())))` |
| WITH CHECK | `-` |

### `credential_update_admin`

| | |
|---|---|
| operation | `UPDATE` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND app.has_perm('credential.write'::text))` |
| WITH CHECK | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND app.has_perm('credential.write'::text))` |


## public.credential_event

### `credential_event_select_scoped`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND (app.has_perm('credential.read.all'::text) OR (app_user_id = auth.uid())))` |
| WITH CHECK | `-` |


## public.credential_type

### `credential_type_select_tenant`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `(tenant_id = app.current_tenant_id())` |
| WITH CHECK | `-` |


## public.document

### `document_select_scoped`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND (destroy_requested_at IS NULL) AND ((employee_id = auth.uid()) OR app.has_perm('staff.manage'::text) OR app.has_perm('credential.read.all'::text) OR ((client_id IS NOT NULL) AND (app.has_perm('client.read.all'::text) OR app.on_care_team(client_id)))))` |
| WITH CHECK | `-` |


## public.employee

### `employee_select_scoped`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND ((id = auth.uid()) OR app.has_perm('staff.manage'::text) OR app.has_perm('credential.read.all'::text)))` |
| WITH CHECK | `-` |


## public.evidence_packet

### `evidence_packet_insert_compliance`

| | |
|---|---|
| operation | `INSERT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `-` |
| WITH CHECK | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND app.has_perm('compliance.read'::text) AND (generated_by = auth.uid()))` |

### `evidence_packet_select_compliance`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND app.has_perm('compliance.read'::text))` |
| WITH CHECK | `-` |


## public.evv_adapter

### `evv_adapter_select_scoped`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND (app.has_perm('evv.read'::text) OR app.has_perm('evv.manage'::text)))` |
| WITH CHECK | `-` |


## public.evv_record

### `evv_record_select_scoped`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND (app.has_perm('evv.read'::text) OR app.has_perm('evv.manage'::text) OR (caregiver_id = auth.uid()) OR app.on_care_team(client_id)))` |
| WITH CHECK | `-` |


## public.evv_submission

### `evv_submission_select_scoped`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND (app.has_perm('evv.read'::text) OR app.has_perm('evv.manage'::text)))` |
| WITH CHECK | `-` |


## public.extraction_field

### `extraction_field_insert_scoped`

| | |
|---|---|
| operation | `INSERT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `-` |
| WITH CHECK | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND (app.has_perm('client.write'::text) OR app.has_perm('ai.manage'::text)) AND (EXISTS ( SELECT 1  FROM extraction_job j  WHERE ((j.id = extraction_field.job_id) AND (j.tenant_id = app.current_tenant_id())))))` |

### `extraction_field_select_scoped`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND (EXISTS ( SELECT 1  FROM extraction_job j  WHERE ((j.id = extraction_field.job_id) AND (j.tenant_id = app.current_tenant_id()) AND (app.has_perm('client.write'::text) OR app.has_perm('client.read.all'::text) OR (j.created_by = auth.uid()) OR ((j.client_id IS NOT NULL) AND app.on_care_team(j.client_id)))))))` |
| WITH CHECK | `-` |

### `extraction_field_update_review`

| | |
|---|---|
| operation | `UPDATE` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND (app.has_perm('client.write'::text) OR app.has_perm('ai.manage'::text)))` |
| WITH CHECK | `((tenant_id = app.current_tenant_id()) AND ((accepted_by IS NULL) OR (accepted_by = auth.uid())))` |


## public.extraction_job

### `extraction_job_insert_self`

| | |
|---|---|
| operation | `INSERT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `-` |
| WITH CHECK | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND (created_by = auth.uid()) AND (app.has_perm('client.write'::text) OR app.has_perm('ai.manage'::text)))` |

### `extraction_job_select_scoped`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND (app.has_perm('client.write'::text) OR app.has_perm('client.read.all'::text) OR (created_by = auth.uid()) OR ((client_id IS NOT NULL) AND app.on_care_team(client_id))))` |
| WITH CHECK | `-` |

### `extraction_job_update_status`

| | |
|---|---|
| operation | `UPDATE` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND (app.has_perm('client.write'::text) OR app.has_perm('ai.manage'::text)))` |
| WITH CHECK | `(tenant_id = app.current_tenant_id())` |


## public.family_link

### `family_link_insert_staff`

| | |
|---|---|
| operation | `INSERT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `-` |
| WITH CHECK | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND (app.has_perm('family.manage'::text) OR app.on_care_team(client_id)))` |

### `family_link_select_scoped`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND ((family_user_id = auth.uid()) OR app.has_perm('client.read.all'::text) OR app.on_care_team(client_id)))` |
| WITH CHECK | `-` |

### `family_link_update_staff`

| | |
|---|---|
| operation | `UPDATE` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND (app.has_perm('family.manage'::text) OR app.on_care_team(client_id)))` |
| WITH CHECK | `(tenant_id = app.current_tenant_id())` |


## public.family_update

### `family_update_insert_staff`

| | |
|---|---|
| operation | `INSERT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `-` |
| WITH CHECK | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND (author_id = auth.uid()) AND (app.has_perm('family.manage'::text) OR app.on_care_team(client_id)))` |

### `family_update_select_scoped`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND (app.has_perm('client.read.all'::text) OR app.on_care_team(client_id) OR app.on_family_link(client_id, 'updates'::text)))` |
| WITH CHECK | `-` |


## public.feature_flag

### `feature_flag_select_tenant`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `(tenant_id = app.current_tenant_id())` |
| WITH CHECK | `-` |


## public.form_instance

### `form_instance_select_scoped`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND (app.has_perm('form.read.all'::text) OR ((client_id IS NOT NULL) AND app.on_care_team(client_id)) OR (created_by = auth.uid())))` |
| WITH CHECK | `-` |


## public.form_template

### `form_template_select_tenant`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `(tenant_id = app.current_tenant_id())` |
| WITH CHECK | `-` |


## public.form_version

### `form_version_select_scoped`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND (EXISTS ( SELECT 1  FROM form_instance fi  WHERE ((fi.id = form_version.instance_id) AND (app.has_perm('form.read.all'::text) OR ((fi.client_id IS NOT NULL) AND app.on_care_team(fi.client_id)) OR (fi.created_by = auth.uid()))))))` |
| WITH CHECK | `-` |


## public.huddle_brief

### `huddle_brief_insert_self`

| | |
|---|---|
| operation | `INSERT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `-` |
| WITH CHECK | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND (generated_by = auth.uid()))` |

### `huddle_brief_select_scoped`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND (app.has_perm('ai.read'::text) OR (for_user = auth.uid()) OR ((for_user IS NULL) AND (role_key IN ( SELECT r.key  FROM (user_role ur   JOIN role r ON ((r.id = ur.role_id)))  WHERE (ur.user_id = auth.uid()))))))` |
| WITH CHECK | `-` |


## public.invitation

### `invitation_select_desk`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND app.has_perm('staff.manage'::text))` |
| WITH CHECK | `-` |


## public.knowledge_chunk

### `knowledge_chunk_insert_manage`

| | |
|---|---|
| operation | `INSERT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `-` |
| WITH CHECK | `((tenant_id = app.current_tenant_id()) AND (app.has_perm('ai.manage'::text) OR app.has_perm('client.write'::text)))` |

### `knowledge_chunk_select_tenant`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `(tenant_id = app.current_tenant_id())` |
| WITH CHECK | `-` |

### `knowledge_chunk_update_embedding`

| | |
|---|---|
| operation | `UPDATE` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND app.has_perm('ai.manage'::text))` |
| WITH CHECK | `((tenant_id = app.current_tenant_id()) AND app.has_perm('ai.manage'::text))` |


## public.knowledge_document

### `knowledge_document_insert_manage`

| | |
|---|---|
| operation | `INSERT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `-` |
| WITH CHECK | `((tenant_id = app.current_tenant_id()) AND (app.has_perm('ai.manage'::text) OR app.has_perm('client.write'::text)))` |

### `knowledge_document_select_tenant`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND active)` |
| WITH CHECK | `-` |


## public.legal_authority

### `legal_authority_select_all`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `true` |
| WITH CHECK | `-` |


## public.notification

### `notification_select_own`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((recipient_id = auth.uid()) AND (tenant_id = app.current_tenant_id()))` |
| WITH CHECK | `-` |

### `notification_update_read`

| | |
|---|---|
| operation | `UPDATE` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((recipient_id = auth.uid()) AND (tenant_id = app.current_tenant_id()))` |
| WITH CHECK | `((recipient_id = auth.uid()) AND (tenant_id = app.current_tenant_id()))` |


## public.obligation

### `obligation_select_scoped`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND (app.has_perm('compliance.read'::text) OR ((client_id IS NOT NULL) AND app.on_care_team(client_id)) OR ((staff_id IS NOT NULL) AND (staff_id = auth.uid()))))` |
| WITH CHECK | `-` |


## public.offer

### `offer_select_scoped`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND ((candidate_user_id = auth.uid()) OR app.has_perm('schedule.read'::text)))` |
| WITH CHECK | `-` |


## public.offer_event

### `offer_event_select_scoped`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND app.has_perm('schedule.read'::text))` |
| WITH CHECK | `-` |


## public.onboarding_checklist

### `onboarding_checklist_select_tenant`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `(tenant_id = app.current_tenant_id())` |
| WITH CHECK | `-` |


## public.onboarding_item

### `onboarding_item_select_scoped`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND ((employee_id = auth.uid()) OR app.has_perm('staff.manage'::text) OR app.has_perm('credential.read.all'::text)))` |
| WITH CHECK | `-` |


## public.onboarding_milestone

### `onboarding_milestone_select_own`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND (user_id = auth.uid()))` |
| WITH CHECK | `-` |


## public.payroll_export

### `payroll_export_select_scoped`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND (app.has_perm('payroll.read'::text) OR app.has_perm('payroll.manage'::text)))` |
| WITH CHECK | `-` |


## public.payroll_period

### `payroll_period_select_scoped`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND (app.has_perm('payroll.read'::text) OR app.has_perm('payroll.manage'::text)))` |
| WITH CHECK | `-` |


## public.permission

### `permission_select_all`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `true` |
| WITH CHECK | `-` |


## public.revocation_checklist

### `revocation_select_desk`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND app.has_perm('staff.manage'::text))` |
| WITH CHECK | `-` |


## public.role

### `role_select_tenant`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `(tenant_id = app.current_tenant_id())` |
| WITH CHECK | `-` |


## public.role_permission

### `role_permission_select_tenant`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `(EXISTS ( SELECT 1  FROM role r  WHERE ((r.id = role_permission.role_id) AND (r.tenant_id = app.current_tenant_id()))))` |
| WITH CHECK | `-` |


## public.schedule_exception

### `schedule_exception_insert_scoped`

| | |
|---|---|
| operation | `INSERT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `-` |
| WITH CHECK | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND (created_by = auth.uid()) AND (EXISTS ( SELECT 1  FROM visit v  WHERE ((v.id = schedule_exception.visit_id) AND (v.tenant_id = app.current_tenant_id()) AND (app.has_perm('schedule.write'::text) OR app.on_care_team(v.client_id) OR (v.caregiver_id = auth.uid()))))))` |

### `schedule_exception_select_scoped`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND (EXISTS ( SELECT 1  FROM visit v  WHERE ((v.id = schedule_exception.visit_id) AND (app.has_perm('schedule.read'::text) OR app.on_care_team(v.client_id) OR (v.caregiver_id = auth.uid()))))))` |
| WITH CHECK | `-` |


## public.service_location

### `service_location_select_scoped`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND (app.has_perm('location.manage'::text) OR app.on_care_team(client_id) OR (EXISTS ( SELECT 1  FROM visit v  WHERE ((v.client_id = service_location.client_id) AND (v.caregiver_id = auth.uid()) AND (v.tenant_id = app.current_tenant_id()))))))` |
| WITH CHECK | `-` |


## public.service_location_version

### `service_location_version_select_parent`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND (EXISTS ( SELECT 1  FROM service_location sl  WHERE (sl.id = service_location_version.service_location_id))))` |
| WITH CHECK | `-` |


## public.service_type

### `service_type_insert_scheduler`

| | |
|---|---|
| operation | `INSERT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `-` |
| WITH CHECK | `((tenant_id = app.current_tenant_id()) AND app.has_perm('schedule.write'::text))` |

### `service_type_select_member`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `(tenant_id = app.current_tenant_id())` |
| WITH CHECK | `-` |

### `service_type_update_scheduler`

| | |
|---|---|
| operation | `UPDATE` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND app.has_perm('schedule.write'::text))` |
| WITH CHECK | `(tenant_id = app.current_tenant_id())` |


## public.shared_document

### `shared_document_insert_staff`

| | |
|---|---|
| operation | `INSERT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `-` |
| WITH CHECK | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND (shared_by = auth.uid()) AND (app.has_perm('family.manage'::text) OR app.on_care_team(client_id)))` |

### `shared_document_select_scoped`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND (app.has_perm('client.read.all'::text) OR app.on_care_team(client_id) OR app.on_family_link(client_id, 'documents'::text)))` |
| WITH CHECK | `-` |


## public.shift

### `shift_select_scoped`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND ((caregiver_id = auth.uid()) OR app.has_perm('schedule.read'::text)))` |
| WITH CHECK | `-` |


## public.signature

### `signature_select_scoped`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND (EXISTS ( SELECT 1  FROM (form_version fv   JOIN form_instance fi ON ((fi.id = fv.instance_id)))  WHERE ((fv.id = signature.form_version_id) AND (app.has_perm('form.read.all'::text) OR ((fi.client_id IS NOT NULL) AND app.on_care_team(fi.client_id)) OR (fi.created_by = auth.uid()))))))` |
| WITH CHECK | `-` |


## public.state_transition

### `state_transition_select_all`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `true` |
| WITH CHECK | `-` |


## public.supervisory_visit

### `supervisory_visit_insert_scoped`

| | |
|---|---|
| operation | `INSERT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `-` |
| WITH CHECK | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND (app.has_perm('form.write.all'::text) OR app.on_care_team(client_id)) AND (EXISTS ( SELECT 1  FROM client c  WHERE ((c.id = supervisory_visit.client_id) AND (c.tenant_id = app.current_tenant_id())))))` |

### `supervisory_visit_select_scoped`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND (app.has_perm('client.read.all'::text) OR app.on_care_team(client_id)))` |
| WITH CHECK | `-` |

### `supervisory_visit_update_scoped`

| | |
|---|---|
| operation | `UPDATE` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND (app.has_perm('form.write.all'::text) OR app.on_care_team(client_id)))` |
| WITH CHECK | `(tenant_id = app.current_tenant_id())` |


## public.tenant

### `tenant_select_own`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `(id = app.current_tenant_id())` |
| WITH CHECK | `-` |


## public.user_role

### `user_role_select_scoped`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((EXISTS ( SELECT 1  FROM app_user u  WHERE ((u.id = user_role.user_id) AND (u.tenant_id = app.current_tenant_id())))) AND ((user_id = auth.uid()) OR app.has_perm('user.read'::text)))` |
| WITH CHECK | `-` |


## public.visit

### `visit_select_scoped`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND (app.has_perm('schedule.read'::text) OR app.on_care_team(client_id) OR (caregiver_id = auth.uid())))` |
| WITH CHECK | `-` |


## public.visit_event

### `visit_event_select_scoped`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND ((caregiver_id = auth.uid()) OR app.has_perm('schedule.read'::text) OR (EXISTS ( SELECT 1  FROM visit v  WHERE ((v.id = visit_event.visit_id) AND app.on_care_team(v.client_id))))))` |
| WITH CHECK | `-` |


## public.visit_exception

### `visit_exception_select_scoped`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND ((caregiver_id = auth.uid()) OR app.has_perm('visit.verify.read'::text) OR (EXISTS ( SELECT 1  FROM visit v  WHERE ((v.id = visit_exception.visit_id) AND app.on_care_team(v.client_id))))))` |
| WITH CHECK | `-` |


## public.visit_exception_disposition

### `visit_exception_disposition_select_scoped`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND (EXISTS ( SELECT 1  FROM visit_exception e  WHERE ((e.id = visit_exception_disposition.exception_id) AND ((e.caregiver_id = auth.uid()) OR app.has_perm('visit.verify.read'::text) OR (EXISTS ( SELECT 1      FROM visit v      WHERE ((v.id = e.visit_id) AND app.on_care_team(v.client_id)))))))))` |
| WITH CHECK | `-` |


## public.visit_policy

### `visit_policy_select_member`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `(tenant_id = app.current_tenant_id())` |
| WITH CHECK | `-` |


## public.visit_trust_assessment

### `visit_trust_assessment_select_verifier`

| | |
|---|---|
| operation | `SELECT` |
| roles | `authenticated` |
| kind | permissive |
| USING | `((tenant_id = app.current_tenant_id()) AND app.is_aal2() AND (app.has_perm('visit.verify.read'::text) OR app.has_perm('schedule.read'::text)))` |
| WITH CHECK | `-` |

## Deny-by-default tables (RLS enabled, no policy)

Reachable only through `security definer` functions. A table appearing here by
accident rather than by design is a bug — the matrix manifest records the intent.

- `audit.audit_anchor`
- `audit.audit_event`
- `public.domain_event`
- `public.job_heartbeat`
- `public.sms_log`
