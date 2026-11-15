import Link from 'next/link';
import {notFound,redirect} from 'next/navigation';
import {currentUser} from '@/lib/auth';
import {canEditSpace,canReadSpace} from '@/lib/roles';
import {getDb} from '@/lib/db';
import {pageRevision} from '@/lib/page-revisions';
import {getPage,getPageBySlug,getSpaceBySlug} from '@/lib/data';
import {boundExchangeSpace,exchangeManagedPage,localDeleteMessages,type LocalDeleteHold} from '@/lib/site-exchange-delete-guard';
import {deletePageAction} from '@/app/actions';
export const dynamic='force-dynamic';
export default async function DeleteExchangePage({params,searchParams}:{params:Promise<{space:string;page:string}>;searchParams:Promise<{hold?:string}>}){
 const user=await currentUser();if(!user)redirect('/login');
 const {space:slug,page:pageSlug}=await params,space=getSpaceBySlug(slug);
 if(!space||!canReadSpace(user,space)||!canEditSpace(user,space.id))notFound();
 const found=getPageBySlug(space.id,pageSlug);if(!found||!exchangeManagedPage(found.id,space.id))notFound();
 const snapshot=getDb().transaction(()=>{const page=getPage(found.id);return page&&page.space_id===space.id?{page,...pageRevision(page.id)}:null;})();if(!snapshot)notFound();
 const {page,revision,epoch}=snapshot;
 const hold=boundExchangeSpace(space.id)?(await searchParams).hold:'scope',reason=hold&&Object.hasOwn(localDeleteMessages,hold)?localDeleteMessages[hold as LocalDeleteHold]:null;
 return <main className="mx-auto max-w-2xl space-y-5 p-8"><h1 className="text-2xl font-semibold">Archive and delete {page.title}</h1><p>This exchange-bound page will be retained in a verified local full-object archive before a signed deletion revision is recorded. Other sites receive deletion intent, not an automatic destructive cascade.</p><p>Close other editor tabs and wait for all saved edits to finish. Child pages must be archived individually first. Unresolved conflicts, active editors and recovery problems hold deletion without losing the page.</p>{reason&&<p role="alert" className="rounded border border-line p-4">{reason}</p>}<form action={deletePageAction}><input type="hidden" name="id" value={page.id}/><input type="hidden" name="space" value={space.slug}/><input type="hidden" name="expectedSpace" value={space.id}/><input type="hidden" name="expectedTenant" value={space.tenant_id??''}/><input type="hidden" name="expectedRevision" value={revision}/><input type="hidden" name="expectedEpoch" value={epoch}/><button disabled={!boundExchangeSpace(space.id)} className="rounded bg-accent px-4 py-2 text-accent-ink">Archive and delete this page</button></form><Link className="underline" href={`/${space.slug}/${page.slug}/edit`}>Cancel and return to editor</Link></main>;
}
