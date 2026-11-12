import { findImportSourceMatches } from "@/lib/import-source-matches";
import { NextRequest,NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { isAgent } from "@/lib/roles";
import { previewImport } from "@/lib/import-preview";
export async function POST(req:NextRequest) {
  const headers={"Cache-Control":"private, no-store",Vary:"Cookie","X-Content-Type-Options":"nosniff"};
  const user=await currentUser();if(!user||isAgent(user))return NextResponse.json({error:"An editor account is required"},{status:403,headers});
  try {
    const form=await req.formData(),file=form.get("file");
    if(!(file instanceof File)||file.size>100*1024*1024)return NextResponse.json({error:"Choose a file under 100 MB"},{status:400,headers});
    const bytes=Buffer.from(await file.arrayBuffer());
    return NextResponse.json({...previewImport(file.name,bytes),sourceMatches:findImportSourceMatches(user,bytes)},{headers});
  }catch(e){return NextResponse.json({error:e instanceof Error?e.message:"Unable to preview"},{status:400,headers});}
}
