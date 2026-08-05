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
  "today.evvNote":
    "Clock in records a GPS-verified visit event (EVV) on the visit record. Your location is captured once at clock-in and once at clock-out. It is not tracked in between.",
  "today.upcoming": "Upcoming visits",
  "today.noClients": "No clients assigned. Assigned clients appear here.",
  "today.myOpenNotes": "My open notes",
  "today.noDrafts": "No open drafts. Drafts are saved automatically and appear here.",
  "today.noteFallback": "Note",
  "today.savedAt": "saved {time}",

  /* ── Family portal ── */
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
  "today.evvNote":
    "Marcar la entrada registra un evento de visita verificado por GPS (EVV) en el registro de la visita. Su ubicación se captura una vez al entrar y una vez al salir. No se rastrea en el intervalo.",
  "today.upcoming": "Próximas visitas",
  "today.noClients": "No tiene clientes asignados. Los clientes asignados aparecen aquí.",
  "today.myOpenNotes": "Mis notas abiertas",
  "today.noDrafts":
    "No hay borradores abiertos. Los borradores se guardan automáticamente y aparecen aquí.",
  "today.noteFallback": "Nota",
  "today.savedAt": "guardado a las {time}",

  /* ── Portal familiar ── */
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
