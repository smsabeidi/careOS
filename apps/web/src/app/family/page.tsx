import { AppShell } from "@/components/shell";
import { EmptyState, PageHeader } from "@/components/ui";
import { IconHeart } from "@/components/icons";

export const metadata = { title: "Family" };

export default function FamilyPage() {
  return (
    <AppShell active="/family">
      <div className="rise mx-auto max-w-xl">
        <PageHeader
          title="Family"
          sub="A window into your loved one's care — always with their consent."
        />
        <EmptyState
          icon={<IconHeart />}
          title="The family portal opens soon"
          body="Once your agency turns it on and consent is on file, approved updates, the visit calendar, and shared documents appear here. Nothing is ever shared without permission."
        />
      </div>
    </AppShell>
  );
}
