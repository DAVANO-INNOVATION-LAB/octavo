"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import {
  authenticate,
  createSession,
  createUser,
  currentUser,
  destroySession,
  userCount,
} from "@/lib/auth";
import {
  addComment,
  createPage,
  createSpace,
  deleteComment,
  deletePage,
  deleteSpace,
  getPage,
  getSpaceBySlug,
  savePage,
  updateSpace,
} from "@/lib/data";
import { getTemplate, type TemplatePage } from "@/lib/templates";

async function requireUser() {
  const user = await currentUser();
  if (!user) redirect("/login");
  return user;
}

// ---- auth ----

export async function setupAction(formData: FormData) {
  if (userCount() > 0) redirect("/login");
  const name = String(formData.get("name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!name || !email.includes("@") || password.length < 8) {
    redirect("/setup?error=1");
  }
  const id = createUser(email, name, password);
  await createSession(id);
  redirect("/");
}

export async function loginAction(formData: FormData) {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const user = authenticate(email, password);
  if (!user) redirect("/login?error=1");
  await createSession(user.id);
  redirect("/");
}

export async function logoutAction() {
  await destroySession();
  redirect("/");
}

// ---- spaces ----

export async function createSpaceAction(formData: FormData) {
  await requireUser();
  const name = String(formData.get("name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const visibility = String(formData.get("visibility") ?? "private");
  const template = getTemplate(String(formData.get("template") ?? "blank"));
  if (!name) redirect("/new?error=1");
  const space = createSpace({ name, description, kind: template.kind, visibility });

  let firstSlug: string | null = null;
  const instantiate = (pages: TemplatePage[], parentId: string | null) => {
    for (const tp of pages) {
      const page = createPage({
        spaceId: space.id,
        parentId,
        title: tp.title,
        content: JSON.stringify(tp.blocks),
      });
      if (!firstSlug) firstSlug = page.slug;
      if (tp.children?.length) instantiate(tp.children, page.id);
    }
  };
  instantiate(template.pages, null);

  revalidatePath("/");
  redirect(`/${space.slug}/${firstSlug ?? ""}${firstSlug ? "/edit" : ""}`);
}

export async function updateSpaceAction(formData: FormData) {
  await requireUser();
  const slug = String(formData.get("slug") ?? "");
  const space = getSpaceBySlug(slug);
  if (!space) redirect("/");
  updateSpace(space.id, {
    name: String(formData.get("name") ?? space.name),
    description: String(formData.get("description") ?? space.description),
    kind: String(formData.get("kind") ?? space.kind),
    visibility: String(formData.get("visibility") ?? space.visibility),
    shelf: String(formData.get("shelf") ?? space.shelf),
  });
  revalidatePath("/");
  revalidatePath(`/${space.slug}`);
  redirect(`/${space.slug}`);
}

export async function deleteSpaceAction(formData: FormData) {
  await requireUser();
  const slug = String(formData.get("slug") ?? "");
  const space = getSpaceBySlug(slug);
  if (space) deleteSpace(space.id);
  revalidatePath("/");
  redirect("/");
}

// ---- pages ----

export async function createPageAction(formData: FormData) {
  await requireUser();
  const spaceSlug = String(formData.get("space") ?? "");
  const parentId = String(formData.get("parentId") ?? "") || null;
  const space = getSpaceBySlug(spaceSlug);
  if (!space) redirect("/");
  const page = createPage({ spaceId: space.id, parentId });
  revalidatePath(`/${space.slug}`);
  redirect(`/${space.slug}/${page.slug}/edit`);
}

export async function deletePageAction(formData: FormData) {
  await requireUser();
  const id = String(formData.get("id") ?? "");
  const spaceSlug = String(formData.get("space") ?? "");
  deletePage(id);
  revalidatePath(`/${spaceSlug}`);
  redirect(`/${spaceSlug}`);
}

export async function publishPageAction(formData: FormData) {
  await requireUser();
  const id = String(formData.get("id") ?? "");
  const publish = String(formData.get("publish") ?? "") === "1";
  const page = getPage(id);
  if (!page) redirect("/");
  const saved = savePage(id, { published: publish });
  const spaceSlug = String(formData.get("space") ?? "");
  revalidatePath(`/${spaceSlug}`);
  redirect(`/${spaceSlug}/${saved?.slug ?? page.slug}${publish ? "" : "/edit"}`);
}

// ---- comments ----

export async function addCommentAction(formData: FormData) {
  const user = await requireUser();
  const pageId = String(formData.get("pageId") ?? "");
  const body = String(formData.get("body") ?? "");
  const page = getPage(pageId);
  if (!page) redirect("/");
  addComment(pageId, user.id, body);
  const spaceSlug = String(formData.get("space") ?? "");
  revalidatePath(`/${spaceSlug}/${page.slug}`);
  redirect(`/${spaceSlug}/${page.slug}#discussion`);
}

export async function deleteCommentAction(formData: FormData) {
  await requireUser();
  const id = String(formData.get("id") ?? "");
  const spaceSlug = String(formData.get("space") ?? "");
  const pageSlug = String(formData.get("page") ?? "");
  deleteComment(id);
  revalidatePath(`/${spaceSlug}/${pageSlug}`);
  redirect(`/${spaceSlug}/${pageSlug}#discussion`);
}
