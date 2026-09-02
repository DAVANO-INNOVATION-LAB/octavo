import { notFound } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { getSiteBySlug } from "@/lib/sites";
import { SiteCover } from "@/components/SiteCover";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ site: string }>;
}) {
  const { site: slug } = await params;
  const site = getSiteBySlug(slug);
  return site ? { title: site.name, description: site.tagline } : {};
}

export default async function SitePage({
  params,
}: {
  params: Promise<{ site: string }>;
}) {
  const { site: slug } = await params;
  const site = getSiteBySlug(slug);
  if (!site) notFound();
  // An unpublished site is a draft: its operators can look at it, nobody else
  // can find it. Publishing is what makes it a site.
  if (!site.published && !(await currentUser())) notFound();
  return <SiteCover site={site} />;
}
