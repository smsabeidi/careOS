import type { Metadata } from "next";
import { headers } from "next/headers";
import { BrandLogo } from "@/components/logo";
import { CopyInstallLink } from "./copy-link";

/* ─────────────────────────────────────────────────────────────────────────────
   /install — how a caregiver puts CareOS on their phone (ST-240a, Front Door W6a)
   ───────────────────────────────────────────────────────────────────────────
   PUBLIC BY DESIGN, AND THEREFORE EMPTY OF EVERYTHING. This page is in the
   middleware's PUBLIC_PATHS: it renders for a visitor with no session at all,
   because the moment it needs a sign-in it stops being useful — the person who
   needs it is standing in a driveway with a phone, a link a coordinator texted
   them, and no app. So it names no client, no caregiver, no agency record and
   no visit. There is no query it can run and no identifier it can receive
   (invariant 5). Read the whole file: if a future edit wants a name on it, the
   answer is that this page cannot have one.

   NO FEATURE FLAG. A public instruction sheet is not a gated capability, and
   gating it would mean the one page you send to somebody who cannot get in is
   the one page that checks whether they are in.

   NOT PUSH. Web push (ST-240b) is a separate, flagged wave gated on the W0(c)
   register decision. The notification section below therefore teaches the
   *platform* mechanics — installed apps can be permitted, browser tabs cannot,
   and iOS asks exactly once — and states the agency condition honestly rather
   than promising a channel that may not be switched on. Nothing here claims a
   shipped feature.

   WHY NO QR CODE. The plan sketched one; a QR generator is a dependency, and
   the zero-new-dependency rule wins over the clever version. A large, copyable
   address does the same job, works when typed by hand, survives a screenshot,
   and can be pasted into a text message — which is how it will actually travel.
──────────────────────────────────────────────────────────────────────────── */

/* The root layout's template appends " · CareOS", so the tab reads
   "Install on your phone · CareOS" rather than the stuttering "Install CareOS · CareOS". */
export const metadata: Metadata = {
  title: "Install on your phone",
  description: "Add CareOS to your phone's home screen. No app store needed.",
};

/**
 * This page's own web address, for the desktop panel.
 *
 * Read from the request rather than an env var so a preview deploy, a staging host and
 * production each print the address the reader is actually on. `x-forwarded-*` comes
 * first because Vercel terminates TLS at the edge and `host` behind it is the internal
 * name. Returns null when there is no host to be had — the panel then says so instead
 * of printing a broken address (docs/10 §8: no state renders a lie).
 */
async function installUrl(): Promise<string | null> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (!host) return null;
  const proto =
    h.get("x-forwarded-proto") ?? (/^(localhost|127\.|\[::1\])/.test(host) ? "http" : "https");
  return `${proto}://${host}/install`;
}

const SECTION = "card p-6 sm:p-7";
const H2 = "title-lg text-[19px] sm:text-[21px]";
/* `space-y-3`, not `flex flex-col gap-3`: a flex container blockifies its children and the
   numbers stop rendering where they belong. The digits are the instruction here. */
const STEPS = "mt-4 list-decimal space-y-3 pl-6 text-[15px] leading-relaxed marker:font-semibold";
const NOTE = "mt-4 text-[14px] leading-relaxed";

export default async function InstallPage() {
  const url = await installUrl();

  return (
    <main className="mx-auto flex w-full max-w-[44rem] flex-col gap-6 px-5 py-10 sm:px-8 sm:py-14">
      {/* ── Hero ─────────────────────────────────────────────────────────────── */}
      <header className="rise flex flex-col gap-4">
        <BrandLogo size={44} onLight />
        <h1 className="title-lg text-[clamp(1.875rem,6vw,2.5rem)] tracking-[-0.025em]">
          Put CareOS on your phone
        </h1>
        <p className="text-[16px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
          It takes about a minute, and you only do it once. Afterwards CareOS opens from your
          home screen like any other app — full screen, already signed in, and able to hold a
          clock-in when you are somewhere with no signal.
        </p>
        <p className="text-[14px] leading-relaxed" style={{ color: "var(--text-muted)" }}>
          If this page opened without a web address bar across the top, CareOS is already
          installed on this phone and you have nothing to do.
        </p>
      </header>

      {/* ── iPhone / iPad ────────────────────────────────────────────────────── */}
      <section className={SECTION} aria-labelledby="ios-heading">
        <h2 className={H2} id="ios-heading">
          On an iPhone or iPad
        </h2>
        <p className="mt-2 text-[15px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
          Use Safari. Chrome and Firefox on an iPhone cannot add anything to the home screen —
          that is Apple&apos;s rule, not ours.
        </p>
        <ol className={STEPS}>
          <li>Open this page in Safari.</li>
          <li>
            Tap the <strong>Share</strong> button — the square with an arrow coming out of the
            top. It sits at the bottom of the screen on an iPhone, and in the top-right corner
            on an iPad.
          </li>
          <li>
            Scroll down the list and tap <strong>Add to Home Screen</strong>.
          </li>
          <li>
            Tap <strong>Add</strong>, top right. CareOS is now on your home screen.
          </li>
        </ol>
        <p className={NOTE} style={{ color: "var(--text-muted)" }}>
          No <em>Add to Home Screen</em> in the list? You are most likely in a private browsing
          window, or in a browser that is not Safari. Open this page in a normal Safari tab and
          look again.
        </p>
      </section>

      {/* ── Android ──────────────────────────────────────────────────────────── */}
      <section className={SECTION} aria-labelledby="android-heading">
        <h2 className={H2} id="android-heading">
          On an Android phone
        </h2>
        <p className="mt-2 text-[15px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
          Use Chrome. Samsung Internet works the same way, with the menu at the bottom instead
          of the top.
        </p>
        <ol className={STEPS}>
          <li>Open this page in Chrome.</li>
          <li>Tap the three-dot menu in the top-right corner.</li>
          <li>
            Tap <strong>Install app</strong>. On an older Chrome it reads{" "}
            <strong>Add to Home screen</strong> instead — either one is the right button.
          </li>
          <li>
            Tap <strong>Install</strong>. CareOS appears on your home screen and in your app
            list.
          </li>
        </ol>
        <p className={NOTE} style={{ color: "var(--text-muted)" }}>
          Chrome sometimes offers to install CareOS on its own, in a bar along the bottom of
          the screen. Tapping that does exactly the same thing.
        </p>
      </section>

      {/* ── Desktop-only: get this address onto the phone ────────────────────────
          Hidden below the large breakpoint because on a phone it is nonsense: the
          reader is already at this address. `lg:` matches the breakpoint the rest
          of the app treats as "a computer" (see the login art panel). */}
      <section className={`${SECTION} hidden lg:block`} aria-labelledby="desktop-heading">
        <h2 className={H2} id="desktop-heading">
          Reading this on a computer?
        </h2>
        {url ? (
          <>
            <p
              className="mt-2 text-[15px] leading-relaxed"
              style={{ color: "var(--text-secondary)" }}
            >
              The phone is the thing that needs CareOS, so get this address onto it: type it
              into the phone&apos;s browser, or copy it and send it to yourself in a message.
            </p>
            <p
              id="install-url"
              className="card-inset mt-4 select-all break-all p-4 font-mono text-[clamp(1rem,2vw,1.375rem)] leading-snug tracking-tight"
            >
              {url}
            </p>
            <div className="mt-4">
              <CopyInstallLink url={url} describedBy="install-url" />
            </div>
          </>
        ) : (
          /* The honest error state. We could not work out the address, so we say that
             plainly and point at the one place it is certainly correct. */
          <p className="mt-2 text-[15px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
            We couldn&apos;t work out this page&apos;s web address to print it for you. It is in
            your browser&apos;s address bar at the top of this window — copy it from there and
            send it to the phone.
          </p>
        )}
      </section>

      {/* ── Notifications ────────────────────────────────────────────────────── */}
      <section className={SECTION} aria-labelledby="notifications-heading">
        <h2 className={H2} id="notifications-heading">
          Turn on notifications
        </h2>
        <p className="mt-2 text-[15px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
          A phone will only send notifications from an app that has been installed — never
          from a browser tab. So install CareOS first, then sign in. If your agency has
          notifications switched on, CareOS asks your permission once, right after that first
          sign-in.
        </p>
        <p className="mt-3 text-[15px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
          Nothing about a client ever appears in a notification — not a name, not an address,
          not a word about their care. A notification only tells you that something is waiting;
          you open CareOS and sign in to see what it is.
        </p>

        <h3 className="mt-6 text-[16px] font-semibold">If you already tapped &ldquo;Don&apos;t Allow&rdquo;</h3>
        <p className="mt-2 text-[15px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
          Both phones ask once and then stop asking, so from here it has to be switched on in
          Settings. On an iPhone the path changed in iOS 18 — to see which one you are on,
          open <strong>Settings → General → About</strong> and read{" "}
          <strong>Software Version</strong>.
        </p>

        <div className="mt-4 flex flex-col gap-4">
          <div className="card-inset p-4">
            <h4 className="text-[15px] font-semibold">iOS 18 or later</h4>
            <ol className={STEPS}>
              <li>
                Open <strong>Settings</strong>.
              </li>
              <li>
                Tap <strong>Apps</strong> — it is in the list, below Privacy &amp; Security.
              </li>
              <li>
                Tap <strong>CareOS</strong>, then <strong>Notifications</strong>.
              </li>
              <li>
                Turn on <strong>Allow Notifications</strong>.
              </li>
            </ol>
          </div>

          <div className="card-inset p-4">
            <h4 className="text-[15px] font-semibold">iOS 17 or earlier</h4>
            <ol className={STEPS}>
              <li>
                Open <strong>Settings</strong>.
              </li>
              <li>
                Scroll to the very bottom, past all the Apple settings, and tap{" "}
                <strong>CareOS</strong>.
              </li>
              <li>
                Tap <strong>Notifications</strong>.
              </li>
              <li>
                Turn on <strong>Allow Notifications</strong>.
              </li>
            </ol>
          </div>

          <div className="card-inset p-4">
            <h4 className="text-[15px] font-semibold">On Android</h4>
            <ol className={STEPS}>
              <li>
                Press and hold the CareOS icon, then tap <strong>App info</strong>.
              </li>
              <li>
                Tap <strong>Notifications</strong> and turn them on.
              </li>
            </ol>
          </div>
        </div>

        <p className={NOTE} style={{ color: "var(--text-muted)" }}>
          No CareOS anywhere in that Settings list? Then it has not been installed to the home
          screen yet — go back to the steps at the top of this page and add it first.
        </p>
      </section>

      {/* ── Closing ──────────────────────────────────────────────────────────── */}
      <section className={SECTION} aria-labelledby="closing-heading">
        <h2 className={H2} id="closing-heading">
          No app store needed
        </h2>
        <p className="mt-2 text-[15px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
          CareOS is not in the App Store or on Google Play, and it does not need to be. What
          you just added is the same CareOS you use in a browser — there is nothing to
          download, nothing to update, and no password to make up a second time. Sign in the
          way you always do.
        </p>
        <p className="mt-3 text-[15px] leading-relaxed" style={{ color: "var(--text-secondary)" }}>
          Stuck on any of this? Ask your coordinator — they can walk through it with you.
        </p>
      </section>
    </main>
  );
}
