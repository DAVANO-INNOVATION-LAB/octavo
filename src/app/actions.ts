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
import { recordAudit } from "@/lib/audit";
import { saveForwardConfig } from "@/lib/audit-forward";
import { saveAskConfig } from "@/lib/ask";
import { applySync } from "@/lib/sync-io";
import { generatePages, importInto } from "@/lib/openapi-pages";
import { markAllRead, markRead, notify, notifyAll } from "@/lib/notify";
import { mentionedUserIds } from "@/lib/mentions";
import {
  createChangeRequest,
  getChangeRequest,
  mergeChangeRequest,
  rebaseChangeRequest,
  reviewChangeRequest,
  setChangeRequestStatus,
} from "@/lib/change-requests";
import { deleteUser, findUserByEmail, setUserRole } from "@/lib/auth";
import type { User } from "@/lib/auth";
import { setSetting } from "@/lib/settings";
import { discover, oidcSettings } from "@/lib/oidc";
import {
  connectorsForSpace,
  createConnector,
  deleteConnector,
} from "@/lib/connectors";
import {
  canAdminSpace,
  may,
  reviewersFor,
  removeSpaceMember,
  setSpaceMember,
} from "@/lib/roles";
import {
  addComment,
  commentAuthor,
  mentionableUsers,
  setThreadResolved,
  createPage,
  createSpace,
  deleteComment,
  deletePage,
  deleteSpace,
  getPage,
  getSpaceBySlug,
  setSpaceVariant,
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
  if (!user) {
    // The address is recorded; the string typed into the password field is
    // never written down, since it is frequently a password typed one box up.
    recordAudit({
      actor: null,
      action: "auth.signin_failed",
      objectType: "session",
      objectLabel: email.slice(0, 120),
    });
    redirect("/login?error=1");
  }
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
  recordAudit({
    actor: user,
    action: "auth.signin",
    objectType: "session",
    objectLabel: user.name,
  });
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
  const user = await currentUser();
  if (user)
    recordAudit({
      actor: user,
      action: "auth.signout",
      objectType: "session",
      objectLabel: user.name,
    });
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
  const user = await requireUser();
  const slug = String(formData.get("slug") ?? "");
  const space = getSpaceBySlug(slug);
  if (space) {
    recordAudit({
      actor: user,
      action: "space.deleted",
      objectType: "space",
      objectId: space.id,
      objectLabel: space.name,
      spaceId: space.id,
      detail: { visibility: space.visibility, kind: space.kind },
    });
    deleteSpace(space.id);
  }
  revalidatePath("/");
  redirect("/");
}

// ---- pages ----

export async function createPageAction(formData: FormData) {
  const user = await requireUser();
  const spaceSlug = String(formData.get("space") ?? "");
  const parentId = String(formData.get("parentId") ?? "") || null;
  const space = getSpaceBySlug(spaceSlug);
  if (!space) redirect("/");
  if (!may(user, space.id, "write")) redirect(`/${space.slug}`);
  const page = createPage({ spaceId: space.id, parentId });
  revalidatePath(`/${space.slug}`);
  redirect(`/${space.slug}/${page.slug}/edit`);
}

export async function deletePageAction(formData: FormData) {
  const user = await requireUser();
  const id = String(formData.get("id") ?? "");
  const spaceSlug = String(formData.get("space") ?? "");
  const doomed = getPage(id);
  if (doomed && !may(user, doomed.space_id, "write")) redirect(`/${spaceSlug}`);
  if (doomed)
    recordAudit({
      actor: user,
      action: "page.deleted",
      objectType: "page",
      objectId: id,
      objectLabel: doomed.title,
      spaceId: doomed.space_id,
      detail: { published: doomed.published === 1 },
    });
  deletePage(id);
  revalidatePath(`/${spaceSlug}`);
  redirect(`/${spaceSlug}`);
}

export async function publishPageAction(formData: FormData) {
  const user = await requireUser();
  const id = String(formData.get("id") ?? "");
  const publish = String(formData.get("publish") ?? "") === "1";
  const page = getPage(id);
  if (!page) redirect("/");
  if (!may(user, page.space_id, "publish")) redirect(`/${String(formData.get("space") ?? "")}`);
  const saved = savePage(id, { published: publish });
  const spaceSlug = String(formData.get("space") ?? "");
  revalidatePath(`/${spaceSlug}`);
  redirect(`/${spaceSlug}/${saved?.slug ?? page.slug}${publish ? "" : "/edit"}`);
}

// ---- comments ----

/**
 * A thread belongs to whoever started it, and to whoever runs the space.
 * Anyone signed in may join a conversation; not anyone may end one.
 */
function mayModerate(user: User, commentId: string, spaceId: string) {
  return commentAuthor(commentId) === user.id || canAdminSpace(user, spaceId);
}

export async function addCommentAction(formData: FormData) {
  const user = await requireUser();
  const pageId = String(formData.get("pageId") ?? "");
  const body = String(formData.get("body") ?? "");
  const page = getPage(pageId);
  if (!page) redirect("/");
  if (!may(user, page.space_id, "comment"))
    redirect(`/${String(formData.get("space") ?? "")}/${page.slug}`);
  const id = addComment(pageId, user.id, body, {
    blockId: String(formData.get("blockId") ?? ""),
    parentId: String(formData.get("parentId") ?? "") || undefined,
    anchorText: String(formData.get("anchorText") ?? ""),
  });
  const spaceSlug = String(formData.get("space") ?? "");
  const parent = String(formData.get("parentId") ?? "");
  const link = `/${spaceSlug}/${page.slug}#t-${parent || id || ""}`;

  // Anyone named in the body, resolved the same way the comment renders.
  notifyAll(mentionedUserIds(body, mentionableUsers()), {
    actor: user,
    kind: "mention",
    title: `${user.name} mentioned you on ${page.title}`,
    body,
    url: link,
    spaceId: page.space_id,
  });

  // And whoever started the thread, if this is a reply and they were not
  // already reached by the mention above.
  if (parent) {
    const rootAuthor = commentAuthor(parent);
    if (rootAuthor && !mentionedUserIds(body, mentionableUsers()).includes(rootAuthor)) {
      notify({
        userId: rootAuthor,
        actor: user,
        kind: "reply",
        title: `${user.name} replied on ${page.title}`,
        body,
        url: link,
        spaceId: page.space_id,
      });
    }
  }

  revalidatePath(`/${spaceSlug}/${page.slug}`);
  // Land on the thread that was just joined rather than the top of the list.
  const anchor = parent || id || "discussion";
  redirect(`/${spaceSlug}/${page.slug}#t-${anchor}`);
}

export async function deleteCommentAction(formData: FormData) {
  const user = await requireUser();
  const id = String(formData.get("id") ?? "");
  const spaceSlug = String(formData.get("space") ?? "");
  const pageSlug = String(formData.get("page") ?? "");
  const pageId = String(formData.get("pageId") ?? "");
  const page = getPage(pageId);
  if (page && mayModerate(user, id, page.space_id)) deleteComment(id);
  revalidatePath(`/${spaceSlug}/${pageSlug}`);
  redirect(`/${spaceSlug}/${pageSlug}#discussion`);
}

export async function setThreadResolvedAction(formData: FormData) {
  const user = await requireUser();
  const id = String(formData.get("id") ?? "");
  const resolved = String(formData.get("resolved") ?? "") === "1";
  const spaceSlug = String(formData.get("space") ?? "");
  const pageSlug = String(formData.get("page") ?? "");
  const pageId = String(formData.get("pageId") ?? "");
  const page = getPage(pageId);
  if (page && mayModerate(user, id, page.space_id)) {
    setThreadResolved(id, user.id, resolved);
  }
  revalidatePath(`/${spaceSlug}/${pageSlug}`);
  redirect(`/${spaceSlug}/${pageSlug}#t-${id}`);
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
  if (role !== "admin" && role !== "member" && role !== "agent")
    redirect("/admin/users");
  setUserRole(id, role);
  recordAudit({
    actor: admin,
    action: "user.role_changed",
    objectType: "user",
    objectId: id,
    objectLabel: id,
    detail: { to: role },
  });
  redirect("/admin/users");
}

export async function deleteUserAction(formData: FormData) {
  const admin = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  if (id === admin.id) redirect("/admin/users?error=self");
  recordAudit({
    actor: admin,
    action: "user.deleted",
    objectType: "user",
    objectId: id,
    objectLabel: id,
  });
  deleteUser(id);
  redirect("/admin/users");
}

export async function resetTotpAction(formData: FormData) {
  const admin = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  setTotpSecret(id, null);
  recordAudit({
    actor: admin,
    action: "auth.totp_reset",
    objectType: "user",
    objectId: id,
    objectLabel: id,
  });
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
    "oidc_admin_domain",
    "oidc_default_role",
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

// ---- space members (space admins run their own space) ----

async function requireSpaceAdmin(spaceSlug: string) {
  const user = await currentUser();
  if (!user) redirect("/login");
  const space = getSpaceBySlug(spaceSlug);
  if (!space) redirect("/");
  if (!canAdminSpace(user, space.id)) redirect(`/${space.slug}`);
  return { user, space };
}

export async function setSpaceMemberAction(formData: FormData) {
  const slug = String(formData.get("space") ?? "");
  const { space } = await requireSpaceAdmin(slug);
  const email = String(formData.get("email") ?? "").toLowerCase().trim();
  const role = String(formData.get("role") ?? "editor") === "admin" ? "admin" : "editor";
  const target = findUserByEmail(email);
  if (!target) redirect(`/${space.slug}/members?error=nouser`);
  setSpaceMember(space.id, target.id, role);
  redirect(`/${space.slug}/members`);
}

export async function removeSpaceMemberAction(formData: FormData) {
  const slug = String(formData.get("space") ?? "");
  const { space } = await requireSpaceAdmin(slug);
  removeSpaceMember(space.id, String(formData.get("userId") ?? ""));
  redirect(`/${space.slug}/members`);
}

/** A space admin adds a connector scoped to their own space. */
export async function createSpaceConnectorAction(formData: FormData) {
  const slug = String(formData.get("space") ?? "");
  const { user, space } = await requireSpaceAdmin(slug);
  createConnector({
    name: String(formData.get("name") ?? ""),
    type: String(formData.get("type") ?? "webhook"),
    baseUrl: String(formData.get("base_url") ?? ""),
    credential: String(formData.get("credential") ?? ""),
    spaceId: space.id, // never instance-wide from here
    createdBy: user.id,
  });
  redirect(`/${space.slug}/connectors?saved=1`);
}

export async function deleteSpaceConnectorAction(formData: FormData) {
  const slug = String(formData.get("space") ?? "");
  const { space } = await requireSpaceAdmin(slug);
  const id = String(formData.get("id") ?? "");
  const owned = connectorsForSpace(space.id).some(
    (c) => c.id === id && c.space_id === space.id
  );
  if (owned) deleteConnector(id);
  redirect(`/${space.slug}/connectors`);
}

// ---- change requests ----

export async function createChangeRequestAction(formData: FormData) {
  const user = await requireUser();
  const pageId = String(formData.get("pageId") ?? "");
  const page = getPage(pageId);
  if (!page) redirect("/");
  if (!may(user, page.space_id, "propose")) redirect(`/${String(formData.get("space") ?? "")}`);
  const cr = createChangeRequest({
    pageId,
    authorId: user.id,
    title: String(formData.get("title") ?? ""),
    description: String(formData.get("description") ?? ""),
    proposedTitle: String(formData.get("proposedTitle") ?? page.title),
    proposedContent: String(formData.get("proposedContent") ?? page.content),
  });
  const spaceSlug = String(formData.get("space") ?? "");
  if (!cr) redirect(`/${spaceSlug}/${page.slug}`);
  recordAudit({
    actor: user,
    action: "cr.created",
    objectType: "change_request",
    objectId: cr.id,
    objectLabel: cr.title,
    spaceId: page.space_id,
    detail: { page: page.title },
  });
  // Whoever can act on the proposal is who hears about it.
  notifyAll(reviewersFor(page.space_id), {
    actor: user,
    kind: "cr.opened",
    title: `${user.name} proposed changes to ${page.title}`,
    body: cr.title,
    url: `/${spaceSlug}/${page.slug}/changes/${cr.id}`,
    spaceId: page.space_id,
  });
  revalidatePath(`/${spaceSlug}/${page.slug}`);
  redirect(`/${spaceSlug}/${page.slug}/changes/${cr.id}`);
}

export async function reviewChangeRequestAction(formData: FormData) {
  const user = await requireUser();
  const id = String(formData.get("id") ?? "");
  const verdict = String(formData.get("verdict") ?? "");
  if (verdict !== "approve" && verdict !== "changes") redirect("/");
  const cr = getChangeRequest(id);
  if (!cr) redirect("/");
  // Reviewing your own proposal is not review. Anyone else signed in may.
  if (cr.author_id === user.id) {
    redirect(
      `/${String(formData.get("space") ?? "")}/${String(formData.get("page") ?? "")}/changes/${id}?error=self`
    );
  }
  const note = String(formData.get("note") ?? "");
  reviewChangeRequest(id, user.id, verdict, note);
  const spaceSlug = String(formData.get("space") ?? "");
  const pageSlug = String(formData.get("page") ?? "");
  notify({
    userId: cr.author_id,
    actor: user,
    kind: "cr.reviewed",
    title: `${user.name} ${verdict === "approve" ? "approved" : "asked for changes on"} ${cr.title}`,
    body: note,
    url: `/${spaceSlug}/${pageSlug}/changes/${id}`,
    spaceId: cr.space_id,
  });
  revalidatePath(`/${spaceSlug}/${pageSlug}/changes/${id}`);
  redirect(`/${spaceSlug}/${pageSlug}/changes/${id}`);
}

export async function mergeChangeRequestAction(formData: FormData) {
  const user = await requireUser();
  const id = String(formData.get("id") ?? "");
  const spaceSlug = String(formData.get("space") ?? "");
  const pageSlug = String(formData.get("page") ?? "");
  const cr = getChangeRequest(id);
  if (!cr) redirect("/");
  if (!may(user, cr.space_id, "merge"))
    redirect(`/${spaceSlug}/${pageSlug}/changes/${id}`);
  const merged = mergeChangeRequest(id, user.id);
  if (merged) {
    recordAudit({
      actor: user,
      action: "cr.merged",
      objectType: "change_request",
      objectId: id,
      objectLabel: cr.title,
      spaceId: cr.space_id,
      detail: { page: cr.page_title, author: cr.author },
    });
    notify({
      userId: cr.author_id,
      actor: user,
      kind: "cr.merged",
      title: `${user.name} merged ${cr.title}`,
      url: `/${spaceSlug}/${pageSlug}`,
      spaceId: cr.space_id,
    });
  }
  revalidatePath(`/${spaceSlug}/${pageSlug}`);
  redirect(`/${spaceSlug}/${pageSlug}/changes/${id}`);
}

export async function setChangeRequestStatusAction(formData: FormData) {
  const user = await requireUser();
  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "");
  if (status !== "open" && status !== "closed") redirect("/");
  const cr = getChangeRequest(id);
  if (!cr) redirect("/");
  // Closing belongs to the author and to whoever runs the space.
  if (cr.author_id !== user.id && !canAdminSpace(user, cr.space_id)) {
    redirect("/");
  }
  setChangeRequestStatus(id, status);
  if (status === "closed")
    notify({
      userId: cr.author_id,
      actor: user,
      kind: "cr.closed",
      title: `${user.name} closed ${cr.title} without merging`,
      url: `/${String(formData.get("space") ?? "")}/${String(formData.get("page") ?? "")}/changes/${id}`,
      spaceId: cr.space_id,
    });
  recordAudit({
    actor: user,
    action: status === "closed" ? "cr.closed" : "cr.reopened",
    objectType: "change_request",
    objectId: id,
    objectLabel: cr.title,
    spaceId: cr.space_id,
  });
  const spaceSlug = String(formData.get("space") ?? "");
  const pageSlug = String(formData.get("page") ?? "");
  redirect(`/${spaceSlug}/${pageSlug}/changes/${id}`);
}

export async function rebaseChangeRequestAction(formData: FormData) {
  const user = await requireUser();
  const id = String(formData.get("id") ?? "");
  const cr = getChangeRequest(id);
  if (!cr) redirect("/");
  if (cr.author_id !== user.id && !canAdminSpace(user, cr.space_id)) redirect("/");
  rebaseChangeRequest(id);
  const spaceSlug = String(formData.get("space") ?? "");
  const pageSlug = String(formData.get("page") ?? "");
  redirect(`/${spaceSlug}/${pageSlug}/changes/${id}`);
}

// ---- notifications ----

export async function markReadAction(formData: FormData) {
  const user = await requireUser();
  markRead(user.id, String(formData.get("id") ?? ""));
  revalidatePath("/inbox");
  redirect("/inbox");
}

export async function markAllReadAction() {
  const user = await requireUser();
  markAllRead(user.id);
  revalidatePath("/inbox");
  redirect("/inbox");
}

export async function saveWebhookAction(formData: FormData) {
  const admin = await requireAdmin();
  const raw = String(formData.get("webhook_url") ?? "").trim();
  // Store only something that parses as a URL; a malformed value would fail
  // silently on every notification thereafter.
  let value: string | null = null;
  if (raw) {
    try {
      const u = new URL(raw);
      if (u.protocol === "http:" || u.protocol === "https:") value = u.toString();
    } catch {
      value = null;
    }
  }
  setSetting("webhook_url", value);
  recordAudit({
    actor: admin,
    action: "admin.settings_changed",
    objectType: "setting",
    objectId: "webhook_url",
    objectLabel: value ? "webhook set" : "webhook cleared",
  });
  redirect("/admin/notifications?saved=1");
}

// ---- markdown sync ----

export async function runSyncAction(formData: FormData) {
  const user = await requireUser();
  const slug = String(formData.get("space") ?? "");
  const space = getSpaceBySlug(slug);
  if (!space) redirect("/");
  if (!canAdminSpace(user, space.id)) redirect(`/${slug}`);

  const report = applySync(space);
  recordAudit({
    actor: user,
    action: "sync.run",
    objectType: "space",
    objectId: space.id,
    objectLabel: space.name,
    spaceId: space.id,
    detail: {
      written: report.written,
      imported: report.imported,
      conflicts: report.conflicts.length,
    },
  });
  revalidatePath(`/${slug}`);
  redirect(
    `/${slug}/sync?done=1&w=${report.written}&i=${report.imported}&c=${report.conflicts.length}`
  );
}

export async function setSpaceVariantAction(formData: FormData) {
  const user = await requireUser();
  const slug = String(formData.get("slug") ?? "");
  const space = getSpaceBySlug(slug);
  if (!space) redirect("/");
  if (!canAdminSpace(user, space.id)) redirect(`/${slug}`);
  setSpaceVariant(space.id, {
    group: String(formData.get("group") ?? ""),
    label: String(formData.get("label") ?? ""),
    kind: String(formData.get("kind") ?? "version"),
    position: Number(formData.get("position") ?? 0),
  });
  recordAudit({
    actor: user,
    action: "space.updated",
    objectType: "space",
    objectId: space.id,
    objectLabel: space.name,
    spaceId: space.id,
    detail: {
      variant_group: String(formData.get("group") ?? ""),
      variant_label: String(formData.get("label") ?? ""),
    },
  });
  revalidatePath("/");
  revalidatePath(`/${slug}`);
  redirect(`/${slug}/settings`);
}

// ---- OpenAPI import ----

export async function importOpenApiAction(formData: FormData) {
  const user = await requireUser();
  const spec = String(formData.get("spec") ?? "");
  const given = String(formData.get("name") ?? "").trim();

  let result;
  try {
    // Read it before creating anything: a space left behind by a failed
    // import is worse than a message saying the document could not be read.
    const preview = generatePages(spec);
    const space = createSpace({
      name: given || preview.api.title || "API",
      description: preview.api.version ? `Version ${preview.api.version}` : "",
      kind: "docs",
    });
    result = importInto(space.id, spec, createPage);
    recordAudit({
      actor: user,
      action: "space.created",
      objectType: "space",
      objectId: space.id,
      objectLabel: space.name,
      spaceId: space.id,
      detail: { from: "openapi", operations: preview.api.operations.length },
    });
    revalidatePath("/");
    redirect(`/${space.slug}`);
  } catch (err) {
    if (err && typeof err === "object" && "digest" in err) throw err; // redirect
    const why = err instanceof Error ? err.message : "the document could not be read";
    redirect(`/import/openapi?error=${encodeURIComponent(why)}`);
  }
}

export async function saveAskAction(formData: FormData) {
  const admin = await requireAdmin();
  saveAskConfig({
    endpoint: String(formData.get("endpoint") ?? ""),
    model: String(formData.get("model") ?? ""),
    key: String(formData.get("key") ?? "") || undefined,
    clearKey: String(formData.get("clearKey") ?? "") === "1",
  });
  recordAudit({
    actor: admin,
    action: "admin.settings_changed",
    objectType: "setting",
    objectId: "ask",
    objectLabel: String(formData.get("endpoint") ?? "") ? "answering configured" : "answering disabled",
  });
  redirect("/admin/ask?saved=1");
}

export async function saveAuditForwardAction(formData: FormData) {
  const admin = await requireAdmin();
  saveForwardConfig({
    syslog: String(formData.get("syslog") ?? ""),
    http: String(formData.get("http") ?? ""),
    token: String(formData.get("token") ?? "") || undefined,
    clearToken: String(formData.get("clearToken") ?? "") === "1",
  });
  recordAudit({
    actor: admin,
    action: "admin.settings_changed",
    objectType: "setting",
    objectId: "audit_forwarding",
    objectLabel: "audit forwarding changed",
  });
  redirect("/admin/audit");
}
