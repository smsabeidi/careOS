import { redirect } from "next/navigation";
import { getProfile, homeFor } from "@/lib/profile";

export default async function Home() {
  const profile = await getProfile();
  if (!profile) redirect("/login");
  redirect(homeFor(profile.roles));
}
