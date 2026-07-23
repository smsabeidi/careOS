import { AppShell } from "@/components/shell";
import { EmptyState, PageHeader, SectionTitle, TintTile } from "@/components/ui";
import {
  IconBell,
  IconCalendar,
  IconClipboard,
  IconHeart,
  IconShield,
  IconUsers,
} from "@/components/icons";

export const metadata = { title: "Family" };

/** A calm preview of what the family portal will hold once it's turned on.
 *  Descriptions only — no data is fabricated until real, consented content exists. */
const PREVIEW = [
  {
    icon: <IconBell width={20} height={20} />,
    title: "Approved updates",
    body: "Gentle notes your loved one's care team has chosen to share with you.",
  },
  {
    icon: <IconCalendar width={20} height={20} />,
    title: "Visit calendar",
    body: "Upcoming visits at a glance — only what you're cleared to see.",
  },
  {
    icon: <IconClipboard width={20} height={20} />,
    title: "Shared documents",
    body: "Care plans and paperwork the agency shares, ready when you need them.",
  },
  {
    icon: <IconUsers width={20} height={20} />,
    title: "Contact & on-call",
    body: "Who to reach during the day, and who's on call after hours.",
  },
];

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

        <section className="mt-6">
          <SectionTitle>What you'll find here</SectionTitle>
          <div className="card stagger divide-y hairline overflow-hidden">
            {PREVIEW.map((item) => (
              <div key={item.title} className="flex items-center gap-4 px-5 py-4">
                <TintTile icon={item.icon} size={40} />
                <div className="min-w-0 flex-1">
                  <p className="text-[15px] font-medium">{item.title}</p>
                  <p
                    className="mt-0.5 text-[13px] leading-relaxed"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    {item.body}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-6">
          <div className="card flex items-start gap-4 p-5">
            <TintTile icon={<IconShield width={20} height={20} />} size={40} />
            <div className="min-w-0">
              <p className="text-[15px] font-semibold tracking-[-0.01em]">Private by default</p>
              <p
                className="mt-1 text-[13.5px] leading-relaxed"
                style={{ color: "var(--text-secondary)" }}
              >
                You only ever see what your loved one has agreed to share — and they can change that
                at any time. Nothing reaches this page without their permission.
              </p>
            </div>
          </div>
        </section>
      </div>
    </AppShell>
  );
}
