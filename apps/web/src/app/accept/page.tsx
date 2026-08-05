import { Suspense } from "react";
import { AcceptClient } from "./accept-client";

export const metadata = { title: "Join your agency" };
export const dynamic = "force-dynamic";

/**
 * Invitation landing — the only door into a tenant (0030). The raw token arrives in
 * the link's query string and goes straight to app.accept_invitation, which knows only
 * its hash. New hires create their sign-in here first; the database refuses acceptance
 * from any account whose email doesn't match the invitation.
 */
export default function AcceptPage() {
  return (
    <Suspense>
      <AcceptClient />
    </Suspense>
  );
}
