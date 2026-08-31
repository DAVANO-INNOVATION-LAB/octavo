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
  userCount, cookieSecure } from "@/lib/auth";
import { verifyTotp } from "@/lib/totp";
import { recordAudit } from "@/lib/audit";
import { asSpaceRole } from "@/lib/capabilities";
import { passwordProblem } from "@/lib/policy";
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
import { findUserByEmail, setUserRole } from "@/lib/auth";
import type { User } from "@/lib/auth";
import { setSetting } from "@/lib/settings";
import { forgetAllReading, pruneReading } from "@/lib/reading";
import { createVisitorToken, revokeVisitorToken } from "@/lib/visitors";
import {
  addGroupMember,
  createGroup,
  deleteGroup,
  getGroup,
  removeGroupMember,
  setGroupClaim,
  setGroupGrant,
} from "@/lib/groups";
import { clampPolicy, pruneAudit } from "@/lib/policy";
import { eraseSubject } from "@/lib/subject";
import { issueScimToken, revokeScimToken } from "@/lib/scim";
import { replicaTarget, scheduleReplication, shipSnapshot } from "@/lib/replicate";
import { discover, oidcSettings } from "@/lib/oidc";
import {
  connectorsForSpace,
  createConnector,
  deleteConnector,
} from "@/lib/connectors";
import {
  canAdminSpace,
  canEditSpace,
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
  getSpace,
  getSpaceBySlug,
  setSpaceVariant,
  getVersion,
  savePage,
  snapshotNow,
  updateSpace,
} from "@/lib/data";
import { getTemplate, templateModelKind, type TemplatePage } from "@/lib/templates";
import { getDb } from "@/lib/db";
import { asIconName } from "@/lib/icons";
import { normalizeOrcid } from "@/lib/orcid";
import {
  doiSettings,
  metadataForPage,
  mintDoi,
  recordDoi,
  saveDoiSettings,
} from "@/lib/doi";
import { setBibliography } from "@/lib/bibliography";

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
  if (!name || !email.includes("@") || passwordProblem(password)) {
    redirect("/setup?error=1");
  }
  const id = createUser(email, name, password);
  await createSession(id);
  redirect("/");
}

export async function loginAction(formData: FormData) {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const result = authenticate(email, password);
  if (!result.ok) {
    // The address is recorded; the string typed into the password field is
    // never written down, since it is frequently a password typed one box up.
    recordAudit({
      actor: null,
      action: "auth.signin_failed",
      objectType: "session",
      objectLabel: email.slice(0, 120),
      detail: result.reason === "locked" ? { locked: true } : undefined,
    });
    redirect(result.reason === "locked" ? "/login?error=locked" : "/login?error=1");
  }
  const user = result.user;
  if (getTotpSecret(user.id)) {
    const jar = await cookies();
    jar.set("octavo_pending_2fa", issuePendingToken(user.id), {
      httpOnly: true,
      sameSite: "lax",
      secure: await cookieSecure(),
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
  // A space built from an engineering template starts with that discipline's
  // model, so the first 3D block someone inserts is already the right one.
  updateSpace(space.id, { model_kind: templateModelKind(template) });

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
    icon: String(formData.get("icon") ?? space.icon),
    model_kind: String(formData.get("model_kind") ?? space.model_kind),
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
  // Deleting an account is the erasure path: sessions, memberships, group
  // seats, comments and notifications go with it. What stays is shared page
  // content and the audit record — see lib/subject for why the chain keeps
  // the name.
  const erased = eraseSubject(id);
  recordAudit({
    actor: admin,
    action: "user.deleted",
    objectType: "user",
    objectId: id,
    objectLabel: id,
    detail: erased,
  });
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
  // Every role the form offers must survive the trip. This used to coerce
  // everything that was not "admin" into "editor", which made the Reader and
  // AI Agent options silently grant write access.
  const role = asSpaceRole(formData.get("role"));
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

/** A page's mark. Same shape as the cover action. */
export async function savePageIconAction(formData: FormData) {
  const user = await requireUser();
  const pageId = String(formData.get("page") ?? "");
  const page = getPage(pageId);
  if (!page) redirect("/");
  if (!canEditSpace(user, page.space_id)) redirect("/");
  const icon = asIconName(formData.get("icon")) ?? "";
  getDb().prepare("UPDATE pages SET icon = ? WHERE id = ?").run(icon, pageId);
  const space = getSpace(page.space_id);
  redirect(`/${space?.slug}/${page.slug}`);
}

/** A space's bibliography — the .bib source, kept verbatim. */
export async function saveBibliographyAction(formData: FormData) {
  const user = await requireUser();
  const spaceId = String(formData.get("space") ?? "");
  const space = getSpace(spaceId);
  if (!space) redirect("/");
  if (!canAdminSpace(user, space.id)) redirect(`/${space.slug}`);
  const count = setBibliography(space.id, String(formData.get("bib") ?? ""));
  redirect(`/${space.slug}/members?refs=${count}`);
}

/** A researcher's own ORCID iD, validated by its check digit. */
export async function saveOrcidAction(formData: FormData) {
  const user = await requireUser();
  const raw = String(formData.get("orcid") ?? "").trim();
  const value = raw === "" ? "" : normalizeOrcid(raw);
  if (value === null) redirect("/account?orcid=invalid");
  getDb().prepare("UPDATE users SET orcid = ? WHERE id = ?").run(value, user.id);
  redirect("/account?orcid=saved");
}

// ---- DOI minting ----

/** Configure the DOI provider. Instance-wide: a prefix belongs to the org. */
export async function saveDoiSettingsAction(formData: FormData) {
  const admin = await requireAdmin();
  const token = String(formData.get("token") ?? "").trim();
  // An empty token means "leave it alone" — the form never shows the secret
  // back, so a blank field must not silently erase it.
  const existing = doiSettings();
  saveDoiSettings({
    provider: String(formData.get("provider") ?? "zenodo") === "datacite" ? "datacite" : "zenodo",
    endpoint: String(formData.get("endpoint") ?? "").trim(),
    prefix: String(formData.get("prefix") ?? "").trim(),
    baseUrl: String(formData.get("base_url") ?? "").trim(),
    token: token || existing?.token || "",
  });
  recordAudit({
    actor: admin,
    action: "admin.settings_changed",
    objectType: "setting",
    objectId: "doi",
    objectLabel: "DOI provider configured",
  });
  redirect("/admin/doi?saved=1");
}

/**
 * Mint a DOI for a page. Deliberately not idempotent-by-accident: minting
 * twice creates two DOIs, so the UI shows what already exists and this
 * action is only reachable from a form the author submits on purpose.
 */
export async function mintDoiAction(formData: FormData) {
  const user = await requireUser();
  const pageId = String(formData.get("page") ?? "");
  const page = getPage(pageId);
  if (!page) redirect("/");
  const space = getSpace(page.space_id);
  if (!space) redirect("/");
  // Minting publishes an external, permanent record of this page. That is a
  // publishing decision, so it takes publish rights in the space.
  if (!may(user, space.id, "publish")) redirect(`/${space.slug}/${page.slug}`);

  const settings = doiSettings();
  if (!settings) redirect(`/${space.slug}/${page.slug}?doi=unconfigured`);
  if (page.published !== 1) redirect(`/${space.slug}/${page.slug}?doi=draft`);

  const meta = metadataForPage(page, space.slug, page.slug, settings.baseUrl);
  const result = await mintDoi(meta, settings);
  if (!result.ok) {
    recordAudit({
      actor: user,
      action: "admin.settings_changed",
      objectType: "doi",
      objectId: page.id,
      objectLabel: `DOI mint failed: ${result.error.slice(0, 120)}`,
      spaceId: space.id,
    });
    redirect(`/${space.slug}/${page.slug}?doi=failed`);
  }

  recordDoi({
    doi: result.doi,
    targetType: "page",
    targetId: page.id,
    versionId: meta.versionId,
    url: result.url,
    provider: settings.provider,
    mintedBy: user.id,
    title: page.title,
  });
  recordAudit({
    actor: user,
    action: "page.published",
    objectType: "doi",
    objectId: page.id,
    objectLabel: `DOI minted: ${result.doi}`,
    spaceId: space.id,
    detail: { doi: result.doi, provider: settings.provider },
  });
  redirect(`/${space.slug}/${page.slug}?doi=minted`);
}

// ---- page covers and space variables ----

const COVER_PRESETS = new Set([
  "dawn", "vermilion", "moss", "indigo", "slate", "night",
]);

/** Set or clear a page's cover: a preset wash or an uploaded image. */
export async function saveCoverAction(formData: FormData) {
  const user = await requireUser();
  const pageId = String(formData.get("page") ?? "");
  const page = getPage(pageId);
  if (!page) redirect("/");
  if (!canEditSpace(user, page.space_id)) redirect("/");

  const raw = String(formData.get("cover") ?? "").trim();
  let cover = "";
  if (raw.startsWith("preset:") && COVER_PRESETS.has(raw.slice(7))) cover = raw;
  else if (raw.startsWith("/api/files/") && /^[/a-zA-Z0-9._-]+$/.test(raw)) cover = raw;

  getDb().prepare("UPDATE pages SET cover = ? WHERE id = ?").run(cover, pageId);
  const space = getSpace(page.space_id);
  redirect(`/${space?.slug}/${page.slug}`);
}

/**
 * The space's variables — the values {{name}} resolves to and audience
 * blocks match against. Space admins own them; they are content policy,
 * not instance policy.
 */
export async function saveSpaceVarsAction(formData: FormData) {
  const user = await requireUser();
  const spaceId = String(formData.get("space") ?? "");
  const space = getSpace(spaceId);
  if (!space) redirect("/");
  if (!canAdminSpace(user, space.id)) redirect(`/${space.slug}`);

  const vars: Record<string, string> = {};
  const names = formData.getAll("var_name").map(String);
  const values = formData.getAll("var_value").map(String);
  for (let i = 0; i < names.length; i++) {
    const name = names[i].trim().slice(0, 60);
    if (!/^[a-zA-Z0-9_.-]+$/.test(name)) continue;
    const value = String(values[i] ?? "").trim().slice(0, 500);
    if (name && value) vars[name] = value;
  }
  setSetting(`vars:${space.id}`, Object.keys(vars).length ? JSON.stringify(vars) : null);
  redirect(`/${space.slug}/members?saved=1`);
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

// ---- reading signals ----

/**
 * Turn reading signals on or off, and set how long they are kept.
 *
 * Switching off deletes what was already collected. A switch that only stops
 * new collection would leave an operator saying "we do not do that" while the
 * old rows sat there, which is not the same sentence.
 */
export async function saveReadingAction(formData: FormData) {
  const admin = await requireAdmin();
  const on = String(formData.get("enabled") ?? "") === "on";
  const days = Math.min(
    3650,
    Math.max(1, Math.round(Number(formData.get("retention_days") ?? 90)) || 90)
  );

  setSetting("reading_signals", on ? "on" : "off");
  setSetting("reading_retention_days", String(days));

  let forgotten = 0;
  if (!on) forgotten = forgetAllReading();
  else pruneReading();

  recordAudit({
    actor: admin,
    action: "admin.settings_changed",
    objectType: "setting",
    objectId: "reading_signals",
    objectLabel: on
      ? `reading signals on, kept ${days} days`
      : "reading signals off, history deleted",
    detail: forgotten ? { rowsDeleted: forgotten } : undefined,
  });
  redirect("/admin/reading?saved=1");
}

// ---- visitor links ----

export async function createVisitorTokenAction(formData: FormData) {
  const slug = String(formData.get("space") ?? "");
  const { user, space } = await requireSpaceAdmin(slug);
  const label = String(formData.get("label") ?? "");
  const days = Number(formData.get("days") ?? 7);

  const { token } = createVisitorToken({
    spaceId: space.id,
    label,
    days,
    createdBy: user.id,
  });
  recordAudit({
    actor: user,
    action: "visit.token_created",
    objectType: "space",
    objectId: space.id,
    objectLabel: label || "visitor link",
    spaceId: space.id,
  });

  // Shown exactly once, carried in an httpOnly cookie rather than the URL so
  // the secret never lands in a server log or a referrer header. It expires
  // in a minute whether or not anyone copies it.
  const jar = await cookies();
  jar.set("octavo_new_visit", JSON.stringify({ token, space: space.slug }), {
    httpOnly: true,
    sameSite: "lax",
    secure: await cookieSecure(),
    path: `/`,
    maxAge: 60,
  });
  redirect(`/${space.slug}/members`);
}

export async function revokeVisitorTokenAction(formData: FormData) {
  const slug = String(formData.get("space") ?? "");
  const { user, space } = await requireSpaceAdmin(slug);
  revokeVisitorToken(String(formData.get("id") ?? ""));
  recordAudit({
    actor: user,
    action: "visit.token_revoked",
    objectType: "space",
    objectId: space.id,
    objectLabel: space.name,
    spaceId: space.id,
  });
  redirect(`/${space.slug}/members`);
}

// ---- groups ----

export async function createGroupAction(formData: FormData) {
  const admin = await requireAdmin();
  const g = createGroup(
    String(formData.get("name") ?? ""),
    String(formData.get("claim") ?? "")
  );
  if (g)
    recordAudit({
      actor: admin,
      action: "group.created",
      objectType: "group",
      objectId: g.id,
      objectLabel: g.name,
    });
  redirect("/admin/groups");
}

export async function deleteGroupAction(formData: FormData) {
  const admin = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const g = getGroup(id);
  if (g) {
    deleteGroup(id);
    recordAudit({
      actor: admin,
      action: "group.deleted",
      objectType: "group",
      objectId: id,
      objectLabel: g.name,
    });
  }
  redirect("/admin/groups");
}

export async function groupMemberAction(formData: FormData) {
  await requireAdmin();
  const groupId = String(formData.get("group") ?? "");
  const remove = String(formData.get("remove") ?? "");
  if (remove) {
    removeGroupMember(groupId, remove);
  } else {
    const target = findUserByEmail(String(formData.get("email") ?? ""));
    if (!target) redirect(`/admin/groups?error=nouser`);
    addGroupMember(groupId, target.id);
  }
  redirect("/admin/groups");
}

export async function groupGrantAction(formData: FormData) {
  await requireAdmin();
  const groupId = String(formData.get("group") ?? "");
  const spaceSlug = String(formData.get("space") ?? "");
  const role = String(formData.get("role") ?? "");
  const space = getSpaceBySlug(spaceSlug);
  if (space) setGroupGrant(groupId, space.id, role === "none" ? null : role);
  redirect("/admin/groups");
}

export async function groupClaimAction(formData: FormData) {
  await requireAdmin();
  setGroupClaim(
    String(formData.get("group") ?? ""),
    String(formData.get("claim") ?? "")
  );
  redirect("/admin/groups");
}

// ---- instance policy ----

export async function savePolicyAction(formData: FormData) {
  const admin = await requireAdmin();
  const next = clampPolicy({
    sessionDays: formData.get("sessionDays"),
    lockoutThreshold: formData.get("lockoutThreshold"),
    lockoutMinutes: formData.get("lockoutMinutes"),
    lockoutWindowMinutes: formData.get("lockoutWindowMinutes"),
    minPasswordLength: formData.get("minPasswordLength"),
    auditRetentionDays: formData.get("auditRetentionDays"),
  });
  setSetting("policy", JSON.stringify(next));
  const pruned = pruneAudit();
  recordAudit({
    actor: admin,
    action: "admin.settings_changed",
    objectType: "setting",
    objectId: "policy",
    objectLabel: "instance policy",
    detail: { ...next, ...(pruned ? { auditRowsPruned: pruned } : {}) },
  });
  redirect("/admin/policy?saved=1");
}

// ---- SCIM provisioning ----

export async function scimTokenAction(formData: FormData) {
  const admin = await requireAdmin();
  const off = String(formData.get("revoke") ?? "");
  if (off) {
    revokeScimToken();
    recordAudit({
      actor: admin,
      action: "admin.settings_changed",
      objectType: "setting",
      objectId: "scim",
      objectLabel: "SCIM provisioning disabled",
    });
    redirect("/admin/sso?scim=off");
  }
  const token = issueScimToken();
  recordAudit({
    actor: admin,
    action: "admin.settings_changed",
    objectType: "setting",
    objectId: "scim",
    objectLabel: "SCIM token issued",
  });
  const jar = await cookies();
  jar.set("octavo_new_scim", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: await cookieSecure(),
    path: "/",
    maxAge: 60,
  });
  redirect("/admin/sso?scim=on");
}

// ---- replication ----

export async function saveReplicaAction(formData: FormData) {
  const admin = await requireAdmin();
  const endpoint = String(formData.get("endpoint") ?? "").trim();
  if (!endpoint) {
    setSetting("replica_target", null);
    scheduleReplication();
    recordAudit({
      actor: admin,
      action: "admin.settings_changed",
      objectType: "setting",
      objectId: "replica",
      objectLabel: "replication disabled",
    });
    redirect("/admin/backups?replica=off");
  }
  setSetting(
    "replica_target",
    JSON.stringify({
      endpoint,
      region: String(formData.get("region") ?? "us-east-1").trim(),
      bucket: String(formData.get("bucket") ?? "").trim(),
      accessKey: String(formData.get("accessKey") ?? "").trim(),
      // An empty secret on save means "keep the one you have" so the form
      // never needs to display it back.
      secretKey:
        String(formData.get("secretKey") ?? "").trim() ||
        (replicaTarget()?.secretKey ?? ""),
      prefix: String(formData.get("prefix") ?? "octavo").trim(),
      intervalMinutes: Number(formData.get("intervalMinutes") ?? 5),
      keepDays: Number(formData.get("keepDays") ?? 14),
    })
  );
  scheduleReplication();
  recordAudit({
    actor: admin,
    action: "admin.settings_changed",
    objectType: "setting",
    objectId: "replica",
    objectLabel: "replication target saved",
  });
  redirect("/admin/backups?replica=saved");
}

export async function shipNowAction() {
  const admin = await requireAdmin();
  const result = await shipSnapshot();
  recordAudit({
    actor: admin,
    action: "admin.backup_created",
    objectType: "replica",
    objectLabel: result.ok ? `shipped ${result.key}` : `ship failed: ${result.error}`,
    detail: { ok: result.ok, bytes: result.bytes ?? 0 },
  });
  redirect(result.ok ? "/admin/backups?replica=shipped" : "/admin/backups?replica=failed");
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
