"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import {
  authenticate,
  consumePendingToken,
  createSession,
  createUser,
  currentUser,
  destroySession,
  getTotpSecret,
  issuePendingToken,
  setTotpSecret,
  userCount,
} from "@/lib/auth";
import { verifyTotp } from "@/lib/totp";
import { deleteUser, setUserRole } from "@/lib/auth";
import { setSetting } from "@/lib/settings";
import { discover, oidcSettings } from "@/lib/oidc";
import { createConnector, deleteConnector } from "@/lib/connectors";
import {
  addComment,
  createPage,
  createSpace,
  deleteComment,
  deletePage,
  deleteSpace,
  getPage,
  getSpaceBySlug,
  getVersion,
  savePage,
  snapshotNow,
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
  if (getTotpSecret(user.id)) {
    const jar = await cookies();
    jar.set("octavo_pending_2fa", issuePendingToken(user.id), {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 300,
    });
    redirect("/login/verify");
  }
  await createSession(user.id);
  redirect("/");
}

export async function verifyTotpAction(formData: FormData) {
  const jar = await cookies();
  const token = jar.get("octavo_pending_2fa")?.value ?? "";
  const userId = consumePendingToken(token);
  if (!userId) redirect("/login?error=1");
  const secret = getTotpSecret(userId);
  const code = String(formData.get("code") ?? "");
  if (!secret || !verifyTotp(secret, code)) redirect("/login/verify?error=1");
  jar.delete("octavo_pending_2fa");
  await createSession(userId);
  redirect("/");
}

export async function enableTotpAction(formData: FormData) {
  const user = await requireUser();
  const secret = String(formData.get("secret") ?? "");
  const code = String(formData.get("code") ?? "");
  if (!/^[A-Z2-7]{16,64}$/.test(secret)) redirect("/account?error=totp");
  if (!verifyTotp(secret, code)) redirect("/account?error=totp");
  setTotpSecret(user.id, secret);
  redirect("/account?enabled=1");
}

export async function disableTotpAction(formData: FormData) {
  const user = await requireUser();
  const secret = getTotpSecret(user.id);
  const code = String(formData.get("code") ?? "");
  if (secret && !verifyTotp(secret, code)) redirect("/account?error=totp");
  setTotpSecret(user.id, null);
  redirect("/account?disabled=1");
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
    typeface: String(formData.get("typeface") ?? space.typeface),
    corners: String(formData.get("corners") ?? space.corners),
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

// ---- version history ----

export async function restoreVersionAction(formData: FormData) {
  await requireUser();
  const versionId = String(formData.get("versionId") ?? "");
  const spaceSlug = String(formData.get("space") ?? "");
  const version = getVersion(versionId);
  if (!version) redirect("/");
  // The state being replaced is always kept, throttle or not.
  snapshotNow(version.page_id);
  const saved = savePage(version.page_id, {
    title: version.title,
    content: version.content,
  });
  revalidatePath(`/${spaceSlug}`);
  redirect(`/${spaceSlug}/${saved?.slug ?? ""}`);
}

// ---- admin ----

async function requireAdmin() {
  const user = await currentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/");
  return user;
}

export async function setRoleAction(formData: FormData) {
  const admin = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const role = String(formData.get("role") ?? "");
  if (id === admin.id) redirect("/admin/users?error=self");
  if (role !== "admin" && role !== "member") redirect("/admin/users");
  setUserRole(id, role);
  redirect("/admin/users");
}

export async function deleteUserAction(formData: FormData) {
  const admin = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  if (id === admin.id) redirect("/admin/users?error=self");
  deleteUser(id);
  redirect("/admin/users");
}

export async function resetTotpAction(formData: FormData) {
  await requireAdmin();
  const id = String(formData.get("id") ?? "");
  setTotpSecret(id, null);
  redirect("/admin/users");
}

export async function saveOidcAction(formData: FormData) {
  await requireAdmin();
  const fields = [
    "oidc_issuer",
    "oidc_client_id",
    "oidc_client_secret",
    "oidc_name",
    "oidc_allowed_domain",
    "base_url",
  ];
  for (const f of fields) {
    const v = String(formData.get(f) ?? "").trim();
    // Leave the stored secret untouched when the field comes back masked.
    if (f === "oidc_client_secret" && v === "********") continue;
    setSetting(f, v || null);
  }
  redirect("/admin/sso?saved=1");
}

export async function testOidcAction() {
  await requireAdmin();
  const settings = oidcSettings();
  if (!settings) redirect("/admin/sso?test=unconfigured");
  try {
    await discover(settings);
    redirect("/admin/sso?test=ok");
  } catch (e) {
    if (e && typeof e === "object" && "digest" in e) throw e; // redirect()
    redirect(`/admin/sso?test=${encodeURIComponent(e instanceof Error ? e.message.slice(0, 80) : "failed")}`);
  }
}

// ---- connectors (runnable cookbooks) ----

export async function createConnectorAction(formData: FormData) {
  const user = await requireAdmin();
  const spaceSlug = String(formData.get("space") ?? "");
  const space = spaceSlug ? getSpaceBySlug(spaceSlug) : null;
  createConnector({
    name: String(formData.get("name") ?? ""),
    type: String(formData.get("type") ?? "webhook"),
    baseUrl: String(formData.get("base_url") ?? ""),
    credential: String(formData.get("credential") ?? ""),
    spaceId: space?.id ?? null,
    createdBy: user.id,
  });
  redirect("/admin/connectors?saved=1");
}

export async function deleteConnectorAction(formData: FormData) {
  await requireAdmin();
  deleteConnector(String(formData.get("id") ?? ""));
  redirect("/admin/connectors");
}
