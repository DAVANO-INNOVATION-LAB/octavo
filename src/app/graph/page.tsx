import { currentUser } from "@/lib/auth";
import { readablePrivateSpaceIds } from "@/lib/roles";
import { linkGraph } from "@/lib/data";
import { SiteHeader } from "@/components/SiteHeader";
import { GraphCanvas } from "@/components/GraphCanvas";

export const dynamic = "force-dynamic";

export const metadata = { title: "Graph" };

export default async function GraphPage() {
  const user = await currentUser();
  const graph = linkGraph(readablePrivateSpaceIds(user));

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">
        <h1 className="wordmark text-2xl text-ink">The knowledge graph</h1>
        <p className="mt-1 text-sm text-muted">
          {graph.nodes.length === 0
            ? "No links yet — type [[ in the editor to connect pages, and they’ll appear here."
            : `${graph.nodes.length} linked pages, ${graph.edges.length} connections. Drag to explore; click a page to open it.`}
        </p>
        {graph.nodes.length > 0 && <GraphCanvas graph={graph} />}
      </main>
    </div>
  );
}
