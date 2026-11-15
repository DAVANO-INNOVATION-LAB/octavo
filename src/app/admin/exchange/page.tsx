import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { listSpaces, EVERYTHING } from "@/lib/data";
import { canAdminSpace } from "@/lib/roles";
import { AdminShell } from "@/components/AdminShell";
import { ExchangePanel } from "./panel";
export const dynamic="force-dynamic";
export const metadata={title:"Disconnected exchange"};
export default async function ExchangePage(){const user=await currentUser();if(!user)redirect('/login');if(user.role!=='admin')redirect('/');return <AdminShell active="/admin/exchange"><h2 className="text-2xl font-semibold">Disconnected-site exchange</h2><p className="mt-2 text-sm text-muted">Explicit, signed file exchange between independently edited libraries. Peers and space lineage must be verified out of band. Bundles contain document data, are signed but not encrypted, and must be transported privately. This captures state at exchange, not every intermediate edit. No accounts, permissions or publication grants are imported.</p><ExchangePanel spaces={listSpaces(EVERYTHING).filter(s=>canAdminSpace(user,s.id)).map(s=>({id:s.id,name:s.name,visibility:s.visibility}))}/></AdminShell>}
