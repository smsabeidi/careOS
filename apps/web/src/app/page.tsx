import { redirect } from "next/navigation";
import { needsWelcome } from "@/lib/onboarding";
import { getProfile, homeFor } from "@/lib/profile";

export default async function Home() {
  const profile = await getProfile();
  if (!profile) redirect("/login");
  // First run comes before the day's work: /mfa lands everybody here, and this is the one
  // place that knows whether a person has been welcomed yet. needsWelcome answers false
  // whenever it cannot prove otherwise, so onboarding can never hold anyone up.
  if (await needsWelcome(profile.roles)) redirect("/welcome");
  redirect(homeFor(profile.roles));
}
