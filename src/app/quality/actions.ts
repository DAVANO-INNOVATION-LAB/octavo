"use server";
import { currentUser } from "@/lib/auth";
import { updateQuality } from "@/lib/quality";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export async function qualityAction(form:FormData) {
  let error=""; const id=String(form.get("pageId")??"");
  try { updateQuality(await currentUser(),form); } catch(e) { error=e instanceof Error?e.message:"Unable to save"; }
  revalidatePath("/quality");
  redirect(`/quality?page=${encodeURIComponent(id)}&${error?`error=${encodeURIComponent(error)}`:"saved=1"}`);
}
