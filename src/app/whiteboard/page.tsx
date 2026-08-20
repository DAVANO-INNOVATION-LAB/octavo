import { SiteHeader } from "@/components/SiteHeader";
import { BoardShell } from "@/components/whiteboard/BoardShell";
import { WhiteboardTabs } from "@/components/whiteboard/WhiteboardTabs";

export const metadata = { title: "Whiteboard" };

export default function WhiteboardPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <WhiteboardTabs />
      <main className="flex-1">
        <BoardShell />
      </main>
    </div>
  );
}
