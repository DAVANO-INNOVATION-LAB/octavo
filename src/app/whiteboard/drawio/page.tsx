import { SiteHeader } from "@/components/SiteHeader";
import { WhiteboardTabs } from "@/components/whiteboard/WhiteboardTabs";
import { DrawioShell } from "@/components/whiteboard/DrawioShell";

export const metadata = { title: "Diagram" };

export default function DrawioPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <WhiteboardTabs />
      <DrawioShell />
    </div>
  );
}
