/* ─────────────────────────────────────────────────────────────────────────────
   i18n — dictionaries (en · es)
   ───────────────────────────────────────────────────────────────────────────
   FLAT and dotted. No nesting: a flat map keys cleanly off a union type, so a
   typo is a compile error rather than a blank label in front of a caregiver.

   `es` is typed `Record<keyof typeof en, string>`, which makes the two objects
   provably key-identical — a missing translation fails `pnpm typecheck`, and an
   extra one fails too. There is no silent-fallback hole to hide in.

   Voice (docs/10 §voice, invariant 14): enterprise-neutral, sentence case, no
   exclamation points. Spanish is usted-form throughout and written for a care
   agency — not machine-literal. These are UI chrome strings only: no PHI, no
   client names, no clinical content ever lands in this file.
──────────────────────────────────────────────────────────────────────────── */

import { DEFAULT_LOCALE, type Locale } from "./config";

export const en = {
  /* ── Navigation rail + account menu ── */
  "nav.command": "Command",
  "nav.approvals": "Approvals",
  "nav.clients": "Clients",
  "nav.compliance": "Compliance",
  "nav.credentials": "Credentials",
  "nav.intake": "Intake",
  "nav.analytics": "Analytics",
  "nav.brain": "Brain",
  "nav.schedule": "Schedule",
  "nav.operations": "Operations",
  "nav.clinical": "Clinical",
  "nav.today": "Today",
  "nav.myClients": "My clients",
  "nav.myNotes": "My notes",
  "nav.family": "Family",
  "nav.staff": "Staff",
  "nav.forms": "Forms",
  "nav.signOut": "Sign out",
  "nav.viewAs": "View as",
  "nav.demo": "Demo",

  /* ── Shared actions and standing labels ── */
  "common.loading": "Loading",
  "common.save": "Save",
  "common.cancel": "Cancel",
  "common.close": "Close",
  "common.search": "Search",
  "common.filter": "Filter",
  "common.all": "All",
  "common.none": "None",
  "common.back": "Back",
  "common.next": "Next",
  "common.previous": "Previous",
  "common.showAll": "Show all",
  "common.tryAgain": "Try again",
  "common.refresh": "Refresh",
  "common.approve": "Approve",
  "common.edit": "Edit",
  "common.reject": "Reject",
  "common.dismiss": "Dismiss",
  "common.acknowledge": "Acknowledge",
  "common.open": "Open",
  "common.view": "View",
  "common.today": "Today",
  "common.yesterday": "Yesterday",
  "common.overdue": "Overdue",
  "common.dueToday": "Due today",
  "common.atRisk": "At risk",
  "common.verifiedSession": "Verified session",
  "common.appendOnlyRecords": "Records are never overwritten",

  /* ── Generic four-state copy (docs/10 §8) ── */
  "states.emptyTitle": "Nothing here yet",
  "states.emptyBody": "When there is something to show, it will appear here.",
  "states.errorTitle": "Couldn't load this",
  "states.errorBody": "Nothing was lost. Try again in a moment.",
  "states.noResults": "No results",
  "states.nothingHere": "Nothing here",

  /* ── Chrome: appearance toggle ── */
  "appearance.label": "Appearance",
  "appearance.light": "Light",
  "appearance.dark": "Dark",
  "appearance.system": "System",

  /* ── Chrome: language toggle ── */
  "language.label": "Language",

  /* ── Page titles ── */
  "page.command": "Command",
  "page.approvals": "Approvals",
  "page.clients": "Clients",
  "page.compliance": "Compliance",
  "page.credentials": "Credentials",
  "page.intake": "Intake",
  "page.evidence": "Evidence",
  "page.analytics": "Analytics",
  "page.brain": "Brain",
  "page.clinical": "Clinical",
  "page.today": "Today",
  "page.family": "Family",
  "page.staff": "Staff",
  "page.forms": "Forms",
  "page.schedule": "Schedule",
  "page.aiActivity": "AI activity",
  /* ── Clinical (RN desk) ── */
  "clinical.tabSignatures": "Needs signature",
  "clinical.tabFlags": "Flags",
  "clinical.tabCarePlans": "Care plans",
  "clinical.tabSupervisory": "Supervisory",
  "clinical.tabCaseload": "Caseload",
  "clinical.clientFallback": "Client",
  "clinical.carePlanFallback": "Care plan",
  "clinical.recordFallback": "Record",
  "clinical.subSignaturesOne": "{count} record needs your signature",
  "clinical.subSignaturesMany": "{count} records need your signature",
  "clinical.subSignaturesNone": "No records awaiting signature",
  "clinical.subFlagsOne": "{count} flag is waiting on your review",
  "clinical.subFlagsMany": "{count} flags are waiting on your review",
  "clinical.subFlagsNone": "No flags are waiting on your review",
  "clinical.subCaseloadOne": "{count} client on your caseload",
  "clinical.subCaseloadMany": "{count} clients on your caseload",
  "clinical.needsYourSignature": "Needs your signature",
  "clinical.noPendingSignature": "No assessments pending signature.",
  "clinical.lastUpdated": "Last updated {date}",
  "clinical.reviewAndSign": "Review & sign",
  "clinical.supervisoryTitle": "Supervisory visits (45/90/120-day)",
  "clinical.noSupervisoryTitle": "No supervisory visits assigned",
  "clinical.noSupervisoryBody":
    "COMAR-mandated 45, 90 and 120-day supervisory visits for your clients appear here with their due dates.",
  "clinical.colClient": "Client",
  "clinical.colVisit": "Visit",
  "clinical.colDue": "Due",
  "clinical.colStatus": "Status",
  "clinical.supervisoryDay": "{days}-day supervisory",
  "clinical.supervisoryOther": "{kind} supervisory",
  "clinical.visitCompleted": "Completed",
  "clinical.visitMissed": "Missed",
  "clinical.visitScheduled": "Scheduled",
  "clinical.yourCaseload": "Your caseload",
  "clinical.noCaseloadTitle": "No caseload assigned yet",
  "clinical.noCaseloadBody":
    "Clients you case-manage appear here once your coordinator assigns them.",

  /* ── Today (caregiver field screen) ── */
  "today.subVisits": "{done} of {total} visits completed",
  "today.yourVisits": "Your visits",
  "today.noVisitsTitle": "No visits scheduled today",
  "today.noVisitsBody":
    "Visits scheduled by your coordinator appear here with the time, client, and address.",
  "today.clientFallback": "Client",
  "today.completed": "Completed",
  "today.inProgress": "In progress",
  "today.openNotes": "Open notes",
  /* Rewritten for docs/17 §7.1: a caregiver surface never says EVV, GPS, geofence,
     accuracy or radius. What it owes them is what is recorded and when. */
  "today.clockNote":
    "Clocking in and out records the time and the place of the visit on the record. Your location is checked once when you start and once when you finish. It is not tracked in between.",
  "today.flagged": "Your coordinator will take a look at this visit.",
  "today.errorTitle": "Couldn't load your day",
  "today.errorBody":
    "Nothing was lost and no visit was changed. Refresh to try again — if it keeps happening, call your coordinator.",
  "today.lockedTitle": "Verify your session to see your visits",
  "today.lockedBody":
    "Visit details name the people you care for, so they open only on a verified session. Your day is unchanged — nothing is missing.",
  "today.lockedCta": "Verify session",
  "today.upcoming": "Upcoming visits",
  "today.noClients": "No clients assigned. Assigned clients appear here.",
  "today.myOpenNotes": "My open notes",
  "today.noDrafts": "No open drafts. Drafts are saved automatically and appear here.",
  "today.noteFallback": "Note",
  "today.savedAt": "saved {time}",
  /* First-run coaching for a genuinely empty day (W-ONB). Distinct from
     `today.noVisitsTitle`: this one is only shown on a verified session that really
     has zero visits, so it may say the day is clear — the AAL1 probe keeps its own
     copy above and must never be answered with this. */
  "today.emptyCoach.title": "Your day is clear",
  "today.emptyCoach.body":
    "When a visit is scheduled for you, it appears here with the time, the address, and the tasks that go with it. If you were expecting one today, call your coordinator — whatever they add shows up here on its own.",

  /* ── The clock (docs/17 §7.1) ──
     Two actions, ever: Clock in → Clocked in · 9:02 AM · Visit in progress →
     Complete visit. The words EVV, GPS, geofence, accuracy, radius and metres are
     absent by design (D-030) — the database hands the UI a bucket, not a distance,
     and every failure line says what happened, what is kept, and what to do next. */
  "clock.in": "Clock in",
  "clock.completeVisit": "Complete visit",
  "clock.visitCompleted": "Visit completed",
  "clock.checking": "Checking location…",
  "clock.saving": "Saving…",
  "clock.clockedInAt": "Clocked in · {time}",
  "clock.clockedOutAt": "Clocked out · {time}",
  "clock.visitInProgress": "Visit in progress",
  "clock.alreadyRecorded": "Already recorded — nothing was duplicated.",
  "clock.flaggedForReview": "Recorded. Your coordinator will take a look at this one.",
  "clock.unverifiedTitle": "We couldn't verify your location yet.",
  "clock.unverifiedBody":
    "Nothing was lost and your visit isn't blocked. Try again, or tell us why and carry on.",
  "clock.hintNear":
    "You may be at a different entrance than the one on file. Try again, or tell us why and carry on.",
  "clock.hintFar":
    "This doesn't look like the address on file for this visit. Try again, or tell us why and carry on.",
  "clock.requestException": "Request exception",
  "clock.reasonLabel": "Reason",
  "clock.reasonPlaceholder": "Choose a reason",
  "clock.reasonHelp": "Your coordinator sees this with the visit, and it stays on the record.",
  "clock.reasonSubmit": "Send and carry on",
  "clock.noteLabel": "Anything to add (optional)",
  "clock.notePlaceholder": "A sentence is plenty.",
  "clock.reasonNoFix": "My phone couldn't find where I am",
  "clock.reasonAlternate": "The visit is at a different address",
  "clock.reasonAddressWrong": "The address on file looks wrong",
  "clock.reasonEmergency": "This is an emergency visit",
  "clock.reasonDevice": "Something is wrong with my phone",
  "clock.reasonNetwork": "I have no signal here",
  "clock.reasonOther": "Another reason",
  "clock.queuedTitle": "Saved on this device",
  "clock.queuedBody":
    "You're offline. This sends by itself as soon as you have a signal — there is nothing else to do.",
  "clock.errQueueFailed":
    "This device wouldn't hold the entry, so nothing was recorded. Move to where you have a signal and try again.",
  "clock.errAal2":
    "Your session needs verifying again. Unlock with your authenticator, then try once more. Nothing was recorded.",
  "clock.errNotYours":
    "This visit is assigned to someone else, so it can't be clocked here. Nothing was recorded.",
  "clock.errNotFound":
    "That visit isn't available to you. Nothing was recorded — check your day and try again.",
  "clock.errAlreadyIn": "You're already clocked in for this visit. Nothing was duplicated.",
  "clock.errNotIn": "There's no open clock-in to close on this visit. Nothing was changed.",
  "clock.errLocationRequired":
    "This visit can only be clocked at the address on file. Nothing was recorded — call your coordinator if you're in the right place.",
  "clock.errExceptionNotAllowed":
    "This visit doesn't allow a reason in place of the location. Nothing was recorded — call your coordinator.",
  "clock.errBadRequest": "Something about that wasn't right, so nothing was recorded. Try again.",
  "clock.errGeneric": "Something went wrong and nothing was recorded. Try again.",
  "clock.errSignedOut": "You've been signed out. Sign in again — nothing was recorded.",

  /* ── Connectivity: three honest states (docs/10 §6) ── */
  "offline.live": "Live",
  "offline.syncing": "Syncing ({count})",
  "offline.offline": "Offline",
  "offline.offlineTitle": "You're offline",
  "offline.offlineBody":
    "You can still clock in and out. Anything you record is held on this device and sends by itself.",
  "offline.offlineHeld":
    "{count} held on this device. They send by themselves as soon as you have a signal.",
  "offline.syncingTitle": "Sending what you recorded",
  "offline.syncingBody": "{count} still to send. You can keep working — this finishes on its own.",
  "offline.sendNow": "Send now",
  "offline.needsAttention":
    "{count} came back needing your attention. Open the visit and clock it again — you'll be asked what happened.",

  /* ── Family portal ── */
  /* The first thing a relative reads before the portal is linked (W-ONB). It says
     what this place is, who decides what appears, and what has to happen next —
     without promising a feature that isn't on yet. */
  "family.welcome.title": "Welcome to the family portal",
  "family.welcome.body":
    "This is where the care team shares what your family member has agreed to share with you: approved updates, the visit calendar, and documents, in one place. It opens once the agency links your account — nothing appears here without consent.",
  "family.sub": "Your family member's care, shared with their consent.",
  "family.notActiveTitle": "Family portal not yet active",
  "family.notActiveBody":
    "When the agency enables the portal and consent is on file, approved updates, the visit calendar, and shared documents appear here. Nothing is shared without consent.",
  "family.whatIncluded": "What this portal includes",
  "family.previewUpdatesTitle": "Approved updates",
  "family.previewUpdatesBody": "Updates the care team has chosen to share with you.",
  "family.previewCalendarTitle": "Visit calendar",
  "family.previewCalendarBody": "Upcoming visits, limited to what you're authorized to view.",
  "family.previewDocumentsTitle": "Shared documents",
  "family.previewDocumentsBody": "Care plans and documents the agency shares.",
  "family.previewContactTitle": "Contact & on-call",
  "family.previewContactBody": "Daytime contacts and after-hours on-call staff.",
  "family.scopeUpdates": "Updates",
  "family.scopeCalendar": "Visit calendar",
  "family.scopeDocuments": "Documents",
  "family.yourFamilyMember": "Your family member",
  "family.yourRelationship": "Your {relationship}",
  "family.youCanView": "You can view:",
  "family.noneGranted": "none granted",
  "family.updatesTitle": "Approved updates",
  "family.noUpdates": "No updates shared yet.",
  "family.calendarTitle": "Visit calendar",
  "family.noVisits": "No visits scheduled.",
  "family.visitCompleted": "Completed",
  "family.documentsTitle": "Shared documents",
  "family.noDocuments": "No documents shared yet.",
  "family.privateTitle": "Private by default",
  "family.privateBody":
    "You see only what {name} has agreed to share, and they can change that at any time. Nothing appears here without their consent.",
  "family.privateFallbackName": "your family member",

  /* ── Sign-in and MFA step-up ── */
  "auth.signIn": "Sign in",
  "auth.tagline": "CareOS care operations platform",
  "auth.workEmail": "Work email",
  "auth.emailPlaceholder": "you@agency.com",
  "auth.password": "Password",
  "auth.signInError":
    "Email and password didn't match. Your entries are unchanged. Check and try again.",
  "auth.signingIn": "Signing in…",
  "auth.continue": "Continue",
  "auth.mfaNext":
    "You'll verify with your authenticator app next. Patient records require a verified session.",
  "auth.mfaEnrollTitle": "Set up your authenticator",
  "auth.mfaVerifyTitle": "Verify your identity",
  "auth.mfaSubtitle": "Patient records open only in a verified session.",
  "auth.mfaChecking": "Checking your security setup",
  "auth.mfaCheckError":
    "Couldn't check your security setup. Your sign-in is intact. Try again.",
  "auth.mfaEnrollError":
    "Couldn't start authenticator setup. Your sign-in is intact. Try again.",
  "auth.mfaChallengeError": "Couldn't start verification. Try again.",
  "auth.mfaCodeError":
    "Code didn't match. Codes refresh every 30 seconds. Enter the current code.",
  "auth.mfaScanHelp":
    "Scan this with any authenticator app (1Password, Google Authenticator, Authy), then enter the 6-digit code it shows.",
  "auth.mfaQrAlt": "Authenticator enrollment QR code",
  "auth.mfaManualKey": "If you can't scan, enter this key manually:",
  "auth.mfaCodeLabel": "6-digit code",
  "auth.mfaVerifying": "Verifying…",
  "auth.mfaVerifyCta": "Verify and continue",

  /* ── First run: the welcome surface (W-ONB) ──
     Guided real work, not a tour (docs/14 §6): every step points at a screen that
     exists today, so the copy promises nothing dark — no command bar, no coaching,
     no imports, no notifications. The caregiver lines obey D-030 the same way the
     clock does: what is recorded, when, and what to do if it goes wrong. Nothing
     here names a regulation; nothing here is PHI. */
  "onboarding.title": "Welcome, {name}",
  "onboarding.intro.owner":
    "You can see the whole agency from here. These steps open the views that answer the questions you get asked most.",
  "onboarding.intro.coordinator":
    "Your desk holds the people, the paperwork, and the days ahead. These steps open the screens you'll use most.",
  "onboarding.intro.rn":
    "Your clinical desk is ready. These steps show you where your signatures, your reviews, and your caseload live.",
  "onboarding.intro.caregiver":
    "Everything you need for a visit is on one screen. Start with the steps below — each one takes about a minute.",
  "onboarding.intro.family":
    "This is your window into your family member's care. These steps explain what you can see and who to call with a question.",
  "onboarding.progress": "{done} of {total} steps finished",
  "onboarding.ready": "Continue to CareOS",
  "onboarding.skip": "Skip for now",
  /* Read out beside a finished row: the tick is a shape and a colour, and this is
     the same fact in words, so "done" never depends on seeing green. */
  "onboarding.stepDone": "Done",
  "onboarding.savedNote":
    "Your progress saves as you go. If you close this page, you can pick up where you left off.",
  "onboarding.error.title": "Couldn't open your welcome page",
  "onboarding.error.body":
    "Nothing was lost, and anything you already finished is saved. Try again, or carry on into CareOS and set the rest up later.",

  /* Steps — caregiver */
  "onboarding.step.first_look.title": "See your day",
  "onboarding.step.first_look.body":
    "Your visits for today, in order, with the time, the client, and the address. This is the screen you'll open the most.",
  "onboarding.step.language.title": "Choose your language",
  "onboarding.step.language.body":
    "CareOS speaks English and Spanish. Pick the one you'd rather read — you can change it whenever you like.",
  "onboarding.step.home_screen.title": "Put CareOS on your phone",
  "onboarding.step.home_screen.body":
    "Add it to your home screen and it opens like an app — straight to your day, with no web address to remember.",
  "onboarding.step.home_screen.ios":
    "On iPhone: open CareOS in Safari, tap the share button, then tap Add to Home Screen.",
  "onboarding.step.home_screen.android":
    "On Android: open CareOS in Chrome, tap the three-dot menu, then tap Add to Home screen.",
  "onboarding.step.how_visits_work.title": "How a visit is recorded",
  "onboarding.step.how_visits_work.body":
    "You open the visit, clock in when you arrive, and complete it when you leave. Your phone confirms you're at the address on file once at the start and once at the end, and not in between. If something isn't right, you can say why and carry on — the visit is never blocked, and nothing you record is lost.",

  /* Steps — family */
  "onboarding.step.what_you_see.title": "What you can see here",
  "onboarding.step.what_you_see.body":
    "Updates, visits, and documents your family member has agreed to share with you, and nothing else. Your family member chooses what is shared, and can change it at any time.",
  "onboarding.step.who_to_contact.title": "Who to talk to",
  "onboarding.step.who_to_contact.body":
    "For anything about day-to-day care, call the agency and ask for the care coordinator, the same as always. This page shows you what's shared; it doesn't replace talking to the team.",

  /* Steps — coordinator and HR */
  "onboarding.step.clients.title": "Open your client roster",
  "onboarding.step.clients.body":
    "Everyone the agency serves, in one list. Open a client to see their chart, their schedule, and what's due.",
  "onboarding.step.intake.title": "Follow a referral through intake",
  "onboarding.step.intake.body":
    "New referrals start here and move forward one step at a time. You can see where each one stands and what it's waiting on.",
  "onboarding.step.compliance.title": "See what's coming due",
  "onboarding.step.compliance.body":
    "Credentials, visits, and paperwork that carry a date, ordered by what needs attention first, so nothing slips quietly.",

  /* Steps — nurse */
  "onboarding.step.clinical_home.title": "Start at your clinical desk",
  "onboarding.step.clinical_home.body":
    "Records waiting for your signature, flags to review, and the clients on your caseload — one screen, in the order that matters.",
  "onboarding.step.reviews.title": "Your scheduled reviews",
  "onboarding.step.reviews.body":
    "Visits you're scheduled to review appear on your desk with their due dates and stay there until you sign. Your signature adds a new record — nothing you write is ever overwritten.",

  /* Steps — owner and admin */
  "onboarding.step.exec_overview.title": "See the agency at a glance",
  "onboarding.step.exec_overview.body":
    "Census, staffing, and what needs attention today — the numbers your team works from, on one screen.",
  "onboarding.step.evidence.title": "Show your work when you're asked",
  "onboarding.step.evidence.body":
    "Every signature, visit, and change is kept with its date and the person behind it. When someone asks to see how care was delivered, it is already gathered.",

} as const;

/** Every key in the corpus. Adding a key here forces a Spanish translation. */
export type TranslationKey = keyof typeof en;

/** A complete dictionary — same keys as `en`, no exceptions. */
export type Dictionary = Record<TranslationKey, string>;

export const es: Dictionary = {
  /* ── Navegación ── */
  "nav.command": "Centro de mando",
  "nav.approvals": "Aprobaciones",
  "nav.clients": "Clientes",
  "nav.compliance": "Cumplimiento",
  "nav.credentials": "Credenciales",
  "nav.intake": "Admisiones",
  "nav.analytics": "Análisis",
  "nav.brain": "Cerebro",
  "nav.schedule": "Programación",
  "nav.operations": "Operaciones",
  "nav.clinical": "Clínica",
  "nav.today": "Hoy",
  "nav.myClients": "Mis clientes",
  "nav.myNotes": "Mis notas",
  "nav.family": "Familia",
  "nav.staff": "Personal",
  "nav.forms": "Formularios",
  "nav.signOut": "Cerrar sesión",
  "nav.viewAs": "Ver como",
  "nav.demo": "Demostración",

  /* ── Acciones y etiquetas comunes ── */
  "common.loading": "Cargando",
  "common.save": "Guardar",
  "common.cancel": "Cancelar",
  "common.close": "Cerrar",
  "common.search": "Buscar",
  "common.filter": "Filtrar",
  "common.all": "Todos",
  "common.none": "Ninguno",
  "common.back": "Atrás",
  "common.next": "Siguiente",
  "common.previous": "Anterior",
  "common.showAll": "Ver todo",
  "common.tryAgain": "Intentar de nuevo",
  "common.refresh": "Actualizar",
  "common.approve": "Aprobar",
  "common.edit": "Editar",
  "common.reject": "Rechazar",
  "common.dismiss": "Descartar",
  "common.acknowledge": "Acusar recibo",
  "common.open": "Abrir",
  "common.view": "Ver",
  "common.today": "Hoy",
  "common.yesterday": "Ayer",
  "common.overdue": "Vencido",
  "common.dueToday": "Vence hoy",
  "common.atRisk": "En riesgo",
  "common.verifiedSession": "Sesión verificada",
  "common.appendOnlyRecords": "Los registros nunca se sobrescriben",

  /* ── Los cuatro estados ── */
  "states.emptyTitle": "Todavía no hay nada",
  "states.emptyBody": "Cuando haya algo que mostrar, aparecerá aquí.",
  "states.errorTitle": "No se pudo cargar",
  "states.errorBody": "No se perdió nada. Vuelva a intentarlo en un momento.",
  "states.noResults": "Sin resultados",
  "states.nothingHere": "No hay nada aquí",

  /* ── Apariencia ── */
  "appearance.label": "Apariencia",
  "appearance.light": "Claro",
  "appearance.dark": "Oscuro",
  "appearance.system": "Sistema",

  /* ── Idioma ── */
  "language.label": "Idioma",

  /* ── Títulos de página ── */
  "page.command": "Centro de mando",
  "page.approvals": "Aprobaciones",
  "page.clients": "Clientes",
  "page.compliance": "Cumplimiento",
  "page.credentials": "Credenciales",
  "page.intake": "Admisiones",
  "page.evidence": "Evidencia",
  "page.analytics": "Análisis",
  "page.brain": "Cerebro",
  "page.clinical": "Clínica",
  "page.today": "Hoy",
  "page.family": "Familia",
  "page.staff": "Personal",
  "page.forms": "Formularios",
  "page.schedule": "Programación",
  "page.aiActivity": "Actividad de IA",
  /* ── Clínica (escritorio de enfermería) ── */
  "clinical.tabSignatures": "Requiere firma",
  "clinical.tabFlags": "Alertas",
  "clinical.tabCarePlans": "Planes de cuidado",
  "clinical.tabSupervisory": "Supervisión",
  "clinical.tabCaseload": "Casos asignados",
  "clinical.clientFallback": "Cliente",
  "clinical.carePlanFallback": "Plan de cuidado",
  "clinical.recordFallback": "Registro",
  "clinical.subSignaturesOne": "{count} registro requiere su firma",
  "clinical.subSignaturesMany": "{count} registros requieren su firma",
  "clinical.subSignaturesNone": "No hay registros pendientes de firma",
  "clinical.subFlagsOne": "{count} alerta espera su revisión",
  "clinical.subFlagsMany": "{count} alertas esperan su revisión",
  "clinical.subFlagsNone": "No hay alertas esperando su revisión",
  "clinical.subCaseloadOne": "{count} cliente en sus casos asignados",
  "clinical.subCaseloadMany": "{count} clientes en sus casos asignados",
  "clinical.needsYourSignature": "Requiere su firma",
  "clinical.noPendingSignature": "No hay evaluaciones pendientes de firma.",
  "clinical.lastUpdated": "Última actualización: {date}",
  "clinical.reviewAndSign": "Revisar y firmar",
  "clinical.supervisoryTitle": "Visitas de supervisión (45/90/120 días)",
  "clinical.noSupervisoryTitle": "No hay visitas de supervisión asignadas",
  "clinical.noSupervisoryBody":
    "Las visitas de supervisión de 45, 90 y 120 días exigidas por COMAR para sus clientes aparecen aquí con sus fechas límite.",
  "clinical.colClient": "Cliente",
  "clinical.colVisit": "Visita",
  "clinical.colDue": "Vence",
  "clinical.colStatus": "Estado",
  "clinical.supervisoryDay": "supervisión de {days} días",
  "clinical.supervisoryOther": "supervisión {kind}",
  "clinical.visitCompleted": "Completada",
  "clinical.visitMissed": "No realizada",
  "clinical.visitScheduled": "Programada",
  "clinical.yourCaseload": "Sus casos asignados",
  "clinical.noCaseloadTitle": "Todavía no tiene casos asignados",
  "clinical.noCaseloadBody":
    "Los clientes que usted gestiona aparecen aquí cuando su coordinador se los asigna.",

  /* ── Hoy (pantalla de campo del cuidador) ── */
  "today.subVisits": "{done} de {total} visitas completadas",
  "today.yourVisits": "Sus visitas",
  "today.noVisitsTitle": "No hay visitas programadas para hoy",
  "today.noVisitsBody":
    "Las visitas que programe su coordinador aparecen aquí con la hora, el cliente y la dirección.",
  "today.clientFallback": "Cliente",
  "today.completed": "Completada",
  "today.inProgress": "En curso",
  "today.openNotes": "Abrir notas",
  "today.clockNote":
    "Marcar la entrada y la salida registra la hora y el lugar de la visita. Su ubicación se comprueba una vez al empezar y una vez al terminar. No se rastrea entre medias.",
  "today.flagged": "Su coordinador revisará esta visita.",
  "today.errorTitle": "No se pudo cargar su día",
  "today.errorBody":
    "No se perdió nada y ninguna visita cambió. Actualice para volver a intentarlo; si sigue ocurriendo, llame a su coordinador.",
  "today.lockedTitle": "Verifique su sesión para ver sus visitas",
  "today.lockedBody":
    "Los detalles de las visitas nombran a las personas que usted atiende, así que solo se abren en una sesión verificada. Su día no ha cambiado: no falta nada.",
  "today.lockedCta": "Verificar sesión",
  "today.upcoming": "Próximas visitas",
  "today.noClients": "No tiene clientes asignados. Los clientes asignados aparecen aquí.",
  "today.myOpenNotes": "Mis notas abiertas",
  "today.noDrafts":
    "No hay borradores abiertos. Los borradores se guardan automáticamente y aparecen aquí.",
  "today.noteFallback": "Nota",
  "today.savedAt": "guardado a las {time}",
  /* Acompañamiento del primer día cuando la agenda está realmente vacía (W-ONB). */
  "today.emptyCoach.title": "Su día está libre",
  "today.emptyCoach.body":
    "Cuando le programen una visita, aparecerá aquí con la hora, la dirección y las tareas que la acompañan. Si esperaba una para hoy, llame a su coordinador: lo que le añada aparecerá aquí solo.",

  /* ── El reloj de la visita (docs/17 §7.1) ── */
  "clock.in": "Marcar entrada",
  "clock.completeVisit": "Finalizar visita",
  "clock.visitCompleted": "Visita finalizada",
  "clock.checking": "Comprobando su ubicación…",
  "clock.saving": "Guardando…",
  "clock.clockedInAt": "Entrada marcada · {time}",
  "clock.clockedOutAt": "Salida marcada · {time}",
  "clock.visitInProgress": "Visita en curso",
  "clock.alreadyRecorded": "Ya estaba registrado: no se duplicó nada.",
  "clock.flaggedForReview": "Registrado. Su coordinador revisará esta visita.",
  "clock.unverifiedTitle": "Todavía no pudimos verificar su ubicación.",
  "clock.unverifiedBody":
    "No se perdió nada y su visita no está bloqueada. Inténtelo de nuevo, o díganos por qué y continúe.",
  "clock.hintNear":
    "Puede que esté en una entrada distinta a la registrada. Inténtelo de nuevo, o díganos por qué y continúe.",
  "clock.hintFar":
    "Esto no parece la dirección registrada para esta visita. Inténtelo de nuevo, o díganos por qué y continúe.",
  "clock.requestException": "Solicitar excepción",
  "clock.reasonLabel": "Motivo",
  "clock.reasonPlaceholder": "Elija un motivo",
  "clock.reasonHelp": "Su coordinador lo ve junto con la visita y queda en el registro.",
  "clock.reasonSubmit": "Enviar y continuar",
  "clock.noteLabel": "Algo que añadir (opcional)",
  "clock.notePlaceholder": "Con una frase basta.",
  "clock.reasonNoFix": "Mi teléfono no pudo encontrar dónde estoy",
  "clock.reasonAlternate": "La visita es en otra dirección",
  "clock.reasonAddressWrong": "La dirección registrada parece incorrecta",
  "clock.reasonEmergency": "Es una visita de emergencia",
  "clock.reasonDevice": "Mi teléfono tiene un problema",
  "clock.reasonNetwork": "Aquí no tengo señal",
  "clock.reasonOther": "Otro motivo",
  "clock.queuedTitle": "Guardado en este dispositivo",
  "clock.queuedBody":
    "Está sin conexión. Esto se enviará solo en cuanto tenga señal; no hay nada más que hacer.",
  "clock.errQueueFailed":
    "Este dispositivo no pudo guardarlo, así que no se registró nada. Vaya a donde tenga señal e inténtelo de nuevo.",
  "clock.errAal2":
    "Su sesión necesita verificarse de nuevo. Desbloquee con su autenticador y vuelva a intentarlo. No se registró nada.",
  "clock.errNotYours":
    "Esta visita está asignada a otra persona, así que no se puede marcar aquí. No se registró nada.",
  "clock.errNotFound":
    "Esa visita no está disponible para usted. No se registró nada; revise su día e inténtelo de nuevo.",
  "clock.errAlreadyIn": "Ya tiene la entrada marcada en esta visita. No se duplicó nada.",
  "clock.errNotIn": "Esta visita no tiene una entrada abierta que cerrar. No se cambió nada.",
  "clock.errLocationRequired":
    "Esta visita solo se puede marcar en la dirección registrada. No se registró nada; llame a su coordinador si está en el lugar correcto.",
  "clock.errExceptionNotAllowed":
    "Esta visita no admite un motivo en lugar de la ubicación. No se registró nada; llame a su coordinador.",
  "clock.errBadRequest": "Algo no estaba bien, así que no se registró nada. Inténtelo de nuevo.",
  "clock.errGeneric": "Algo salió mal y no se registró nada. Inténtelo de nuevo.",
  "clock.errSignedOut": "Su sesión se cerró. Vuelva a iniciar sesión; no se registró nada.",

  /* ── Conectividad: tres estados honestos (docs/10 §6) ── */
  "offline.live": "En línea",
  "offline.syncing": "Enviando ({count})",
  "offline.offline": "Sin conexión",
  "offline.offlineTitle": "Está sin conexión",
  "offline.offlineBody":
    "Puede seguir marcando entradas y salidas. Lo que registre se guarda en este dispositivo y se envía solo.",
  "offline.offlineHeld":
    "{count} guardado(s) en este dispositivo. Se enviarán solos en cuanto tenga señal.",
  "offline.syncingTitle": "Enviando lo que registró",
  "offline.syncingBody": "Quedan {count} por enviar. Puede seguir trabajando: esto termina solo.",
  "offline.sendNow": "Enviar ahora",
  "offline.needsAttention":
    "{count} necesita(n) su atención. Abra la visita y márquela de nuevo; se le preguntará qué pasó.",

  /* ── Portal familiar ── */
  /* Lo primero que lee un familiar antes de que el portal esté vinculado (W-ONB). */
  "family.welcome.title": "Le damos la bienvenida al portal familiar",
  "family.welcome.body":
    "Aquí el equipo de cuidado comparte lo que su familiar ha aceptado compartir con usted: novedades aprobadas, el calendario de visitas y los documentos, en un solo lugar. Se abre cuando la agencia vincula su cuenta; aquí no aparece nada sin consentimiento.",
  "family.sub": "El cuidado de su familiar, compartido con su consentimiento.",
  "family.notActiveTitle": "El portal familiar aún no está activo",
  "family.notActiveBody":
    "Cuando la agencia active el portal y el consentimiento esté registrado, aquí aparecerán las novedades aprobadas, el calendario de visitas y los documentos compartidos. No se comparte nada sin consentimiento.",
  "family.whatIncluded": "Qué incluye este portal",
  "family.previewUpdatesTitle": "Novedades aprobadas",
  "family.previewUpdatesBody":
    "Novedades que el equipo de cuidado ha decidido compartir con usted.",
  "family.previewCalendarTitle": "Calendario de visitas",
  "family.previewCalendarBody":
    "Próximas visitas, limitadas a lo que usted está autorizado a ver.",
  "family.previewDocumentsTitle": "Documentos compartidos",
  "family.previewDocumentsBody": "Planes de cuidado y documentos que comparte la agencia.",
  "family.previewContactTitle": "Contacto y guardia",
  "family.previewContactBody":
    "Contactos de horario diurno y personal de guardia fuera de horario.",
  "family.scopeUpdates": "Novedades",
  "family.scopeCalendar": "Calendario de visitas",
  "family.scopeDocuments": "Documentos",
  "family.yourFamilyMember": "Su familiar",
  "family.yourRelationship": "Su {relationship}",
  "family.youCanView": "Usted puede ver:",
  "family.noneGranted": "nada autorizado",
  "family.updatesTitle": "Novedades aprobadas",
  "family.noUpdates": "Todavía no se han compartido novedades.",
  "family.calendarTitle": "Calendario de visitas",
  "family.noVisits": "No hay visitas programadas.",
  "family.visitCompleted": "Completada",
  "family.documentsTitle": "Documentos compartidos",
  "family.noDocuments": "Todavía no se han compartido documentos.",
  "family.privateTitle": "Privado de forma predeterminada",
  "family.privateBody":
    "Usted solo ve lo que {name} ha aceptado compartir, y puede cambiarlo en cualquier momento. Aquí no aparece nada sin su consentimiento.",
  "family.privateFallbackName": "su familiar",

  /* ── Inicio de sesión y verificación MFA ── */
  "auth.signIn": "Iniciar sesión",
  "auth.tagline": "CareOS, plataforma de operaciones de cuidado",
  "auth.workEmail": "Correo del trabajo",
  "auth.emailPlaceholder": "usted@agencia.com",
  "auth.password": "Contraseña",
  "auth.signInError":
    "El correo y la contraseña no coinciden. Sus datos no se modificaron. Revíselos e inténtelo de nuevo.",
  "auth.signingIn": "Iniciando sesión…",
  "auth.continue": "Continuar",
  "auth.mfaNext":
    "A continuación verificará con su aplicación de autenticación. Los registros de pacientes requieren una sesión verificada.",
  "auth.mfaEnrollTitle": "Configure su autenticador",
  "auth.mfaVerifyTitle": "Verifique su identidad",
  "auth.mfaSubtitle": "Los registros de pacientes solo se abren en una sesión verificada.",
  "auth.mfaChecking": "Comprobando su configuración de seguridad",
  "auth.mfaCheckError":
    "No se pudo comprobar su configuración de seguridad. Su sesión sigue intacta. Inténtelo de nuevo.",
  "auth.mfaEnrollError":
    "No se pudo iniciar la configuración del autenticador. Su sesión sigue intacta. Inténtelo de nuevo.",
  "auth.mfaChallengeError": "No se pudo iniciar la verificación. Inténtelo de nuevo.",
  "auth.mfaCodeError":
    "El código no coincide. Los códigos se renuevan cada 30 segundos. Introduzca el código actual.",
  "auth.mfaScanHelp":
    "Escanee esto con cualquier aplicación de autenticación (1Password, Google Authenticator, Authy) e introduzca el código de 6 dígitos que muestre.",
  "auth.mfaQrAlt": "Código QR para registrar el autenticador",
  "auth.mfaManualKey": "Si no puede escanear, introduzca esta clave manualmente:",
  "auth.mfaCodeLabel": "Código de 6 dígitos",
  "auth.mfaVerifying": "Verificando…",
  "auth.mfaVerifyCta": "Verificar y continuar",

  /* ── Primer inicio: la pantalla de bienvenida (W-ONB) ──
     Trabajo real guiado, no un recorrido: cada paso apunta a una pantalla que ya
     existe. El tratamiento es de usted, igual que en el resto del corpus, y las
     líneas del cuidador respetan D-030: qué se registra, cuándo, y qué hacer si
     algo falla. Aquí no se cita ninguna norma y no hay datos de ningún cliente. */
  "onboarding.title": "Le damos la bienvenida, {name}",
  "onboarding.intro.owner":
    "Desde aquí puede ver toda la agencia. Estos pasos abren las vistas que responden a las preguntas que más le hacen.",
  "onboarding.intro.coordinator":
    "Su escritorio reúne a las personas, los documentos y los días que vienen. Estos pasos abren las pantallas que más va a usar.",
  "onboarding.intro.rn":
    "Su escritorio clínico ya está listo. Estos pasos le muestran dónde están sus firmas, sus revisiones y sus casos asignados.",
  "onboarding.intro.caregiver":
    "Todo lo que necesita para una visita está en una sola pantalla. Empiece por los pasos de abajo: cada uno le lleva un minuto.",
  "onboarding.intro.family":
    "Esta es su ventana al cuidado de su familiar. Estos pasos le explican qué puede ver y a quién llamar si tiene una pregunta.",
  "onboarding.progress": "{done} de {total} pasos completados",
  "onboarding.ready": "Continuar a CareOS",
  "onboarding.skip": "Omitir por ahora",
  "onboarding.stepDone": "Completado",
  "onboarding.savedNote":
    "Su progreso se guarda solo. Si cierra esta página, puede continuar donde lo dejó.",
  "onboarding.error.title": "No se pudo abrir su página de bienvenida",
  "onboarding.error.body":
    "No se perdió nada y lo que ya completó está guardado. Vuelva a intentarlo, o continúe a CareOS y configure el resto más tarde.",

  /* Pasos — cuidador */
  "onboarding.step.first_look.title": "Vea su día",
  "onboarding.step.first_look.body":
    "Sus visitas de hoy, en orden, con la hora, el cliente y la dirección. Es la pantalla que más va a abrir.",
  "onboarding.step.language.title": "Elija su idioma",
  "onboarding.step.language.body":
    "CareOS está en inglés y en español. Elija el idioma en el que prefiera leer; puede cambiarlo cuando quiera.",
  "onboarding.step.home_screen.title": "Ponga CareOS en su teléfono",
  "onboarding.step.home_screen.body":
    "Añádalo a su pantalla de inicio y se abrirá como una aplicación: directo a su día, sin ninguna dirección web que recordar.",
  "onboarding.step.home_screen.ios":
    "En iPhone: abra CareOS en Safari, toque el botón de compartir y luego toque Añadir a pantalla de inicio.",
  "onboarding.step.home_screen.android":
    "En Android: abra CareOS en Chrome, toque el menú de tres puntos y luego toque Añadir a pantalla de inicio.",
  "onboarding.step.how_visits_work.title": "Cómo se registra una visita",
  "onboarding.step.how_visits_work.body":
    "Usted abre la visita, marca la entrada al llegar y la finaliza al salir. Su teléfono confirma que está en la dirección registrada una vez al empezar y otra al terminar, y no entre medias. Si algo no cuadra, puede decir por qué y continuar: la visita nunca se bloquea y nada de lo que registra se pierde.",

  /* Pasos — familia */
  "onboarding.step.what_you_see.title": "Qué puede ver aquí",
  "onboarding.step.what_you_see.body":
    "Novedades, visitas y documentos que su familiar ha aceptado compartir con usted, y nada más. Su familiar decide qué se comparte y puede cambiarlo en cualquier momento.",
  "onboarding.step.who_to_contact.title": "Con quién hablar",
  "onboarding.step.who_to_contact.body":
    "Para cualquier asunto del cuidado diario, llame a la agencia y pregunte por el coordinador de cuidado, igual que siempre. Esta página le muestra lo que se comparte; no sustituye hablar con el equipo.",

  /* Pasos — coordinación y recursos humanos */
  "onboarding.step.clients.title": "Abra su lista de clientes",
  "onboarding.step.clients.body":
    "Todas las personas a las que atiende la agencia, en una sola lista. Abra un cliente para ver su expediente, su programación y lo que está pendiente.",
  "onboarding.step.intake.title": "Siga una referencia por el proceso de admisión",
  "onboarding.step.intake.body":
    "Las nuevas referencias empiezan aquí y avanzan paso a paso. Puede ver en qué punto está cada una y qué le falta.",
  "onboarding.step.compliance.title": "Vea lo que está por vencer",
  "onboarding.step.compliance.body":
    "Credenciales, visitas y documentos con fecha, ordenados por lo que necesita atención primero, para que nada se pase por alto.",

  /* Pasos — enfermería */
  "onboarding.step.clinical_home.title": "Empiece en su escritorio clínico",
  "onboarding.step.clinical_home.body":
    "Registros que esperan su firma, alertas por revisar y los clientes de sus casos asignados: una sola pantalla, en el orden que importa.",
  "onboarding.step.reviews.title": "Sus revisiones programadas",
  "onboarding.step.reviews.body":
    "Las visitas que le toca revisar aparecen en su escritorio con su fecha límite y siguen ahí hasta que usted firme. Su firma añade un registro nuevo: nada de lo que escribe se sobrescribe.",

  /* Pasos — dirección */
  "onboarding.step.exec_overview.title": "Vea la agencia de un vistazo",
  "onboarding.step.exec_overview.body":
    "El censo, el personal y lo que necesita atención hoy: las cifras con las que trabaja su equipo, en una sola pantalla.",
  "onboarding.step.evidence.title": "Muestre su trabajo cuando se lo pidan",
  "onboarding.step.evidence.body":
    "Cada firma, cada visita y cada cambio se guarda con su fecha y con la persona que lo hizo. Cuando alguien pida ver cómo se prestó el cuidado, ya está reunido.",

};

export const DICTIONARIES: Record<Locale, Dictionary> = { en, es };

/** Interpolation values. Numbers are formatted for the locale by `createTranslator`. */
export type TranslationVars = Record<string, string | number>;

/** The one translate signature — identical on the server and in the browser. */
export type Translate = (key: TranslationKey, vars?: TranslationVars) => string;

export function getDictionary(locale: Locale): Dictionary {
  return DICTIONARIES[locale] ?? DICTIONARIES[DEFAULT_LOCALE];
}

/** Total keys in the corpus — used by the dictionary parity test. */
export const TRANSLATION_KEY_COUNT = Object.keys(en).length;

/**
 * Builds `t(key, vars?)` for a locale.
 *
 * Interpolation is `{name}` — e.g. t("x", { count: 3 }) fills `{count}`.
 * Numbers go through Intl.NumberFormat so 1,204 reads as 1.204 in Spanish.
 * A token with no matching var is left intact rather than blanked, so a copy
 * bug shows itself instead of silently vanishing from the screen.
 */
export function createTranslator(locale: Locale): Translate {
  const dict = getDictionary(locale);
  const fallback = DICTIONARIES[DEFAULT_LOCALE];

  return function t(key, vars) {
    const template = dict[key] ?? fallback[key] ?? key;
    if (!vars) return template;

    return template.replace(/\{(\w+)\}/g, (match, name: string) => {
      const value = vars[name];
      if (value === undefined) return match;
      return typeof value === "number" ? new Intl.NumberFormat(locale).format(value) : value;
    });
  };
}
