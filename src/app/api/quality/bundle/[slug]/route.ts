import {currentUser} from "@/lib/auth";
import {getSpaceBySlug} from "@/lib/data";
import {releaseBundle} from "@/lib/release-bundle";
export async function GET(req:Request,{params}:{params:Promise<{slug:string}>}) {
 const {slug}=await params, space=getSpaceBySlug(slug);
 if(!space)return new Response('Not found',{status:404});
 try {
  const version=new URL(req.url).searchParams.get('version')||new Date().toISOString().slice(0,10);
  const data=releaseBundle(await currentUser(),space,version);
  return new Response(new Uint8Array(data),{headers:{'Content-Type':'application/zip','Content-Disposition':`attachment; filename="${space.slug}-${version}.zip"`,'Cache-Control':'no-store'}});
 }catch(e){return new Response(e instanceof Error?e.message:'Export failed',{status:400});}
}
