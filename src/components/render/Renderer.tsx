import { Children as ReactChildren, cloneElement, Fragment, isValidElement } from "react";
import type { ReactElement, ReactNode } from "react";
import {
  Block,
  InlineContent,
  TableContent,
  cellContent,
  inlineText,
} from "@/lib/blocks";
import katex from "katex";
import {
  AlertTriangle,
  CheckCircle2,
  Info,
  OctagonAlert,
} from "lucide-react";
import { CodeBlock } from "./CodeBlock";
import { RunButton } from "./RunButton";
import { Model3D, type ModelKind } from "./Model3D";
import { MarginNote } from "./MarginNote";
import { Mermaid } from "./Mermaid";
import { TableCsv } from "./TableCsv";
import { ApiRequest } from "./ApiRequest";
import { isOffline } from "@/lib/runtime-config";

/** Recognize YouTube/Vimeo URLs and return a privacy-friendly embed URL. */
function videoEmbedUrl(url: string): string | null {
  const yt = url.match(
    /(?:youtube\.com\/watch\?.*v=|youtu\.be\/|youtube\.com\/embed\/)([\w-]{6,20})/
  );
  if (yt) return `https://www.youtube-nocookie.com/embed/${yt[1]}`;
  const vimeo = url.match(/vimeo\.com\/(\d{6,12})/);
  if (vimeo) return `https://player.vimeo.com/video/${vimeo[1]}`;
  return null;
}

/* ————— inline content ————— */

function renderInline(content?: InlineContent[] | TableContent): ReactNode {
  if (!content || !Array.isArray(content)) return null;
  return content.map((c, i) => {
    if (c.type === "link") {
      const href = safeHref(c.href);
      return (
        <a key={i} href={href} rel="noopener noreferrer">
          {renderInline(c.content)}
        </a>
      );
    }
    let node: ReactNode = c.text;
    const s = c.styles ?? {};
    if (s.note && typeof s.note === "string") {
      return (
        <MarginNote key={i} note={s.note}>
          {c.text}
        </MarginNote>
      );
    }
    if (s.code) node = <code>{node}</code>;
    if (s.bold) node = <strong>{node}</strong>;
    if (s.italic) node = <em>{node}</em>;
    if (s.underline) node = <u>{node}</u>;
    if (s.strike) node = <s>{node}</s>;
    return <span key={i}>{node}</span>;
  });
}

function safeHref(href: string): string {
  const h = href.trim();
  if (/^(https?:|mailto:|tel:|\/|#)/i.test(h)) return h;
  return `https://${h}`;
}

/* ————— block content ————— */

export type RunContext = {
  pageId: string;
  connectors: { id: string; name: string; type: string }[];
  lastRuns: Record<string, {
    status: string;
    user_name: string;
    started: number;
    output: string;
    external_url: string;
  }>;
};

type Ctx = {
  headingSeen: Map<string, number>;
  run?: RunContext;
  /** Blocks carrying comment threads, so the reader can mark them. */
  threads?: Map<string, { open: number; resolved: number }>;
};

function headingId(ctx: Ctx, text: string): string {
  let slug =
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "section";
  const n = ctx.headingSeen.get(slug) ?? 0;
  ctx.headingSeen.set(slug, n + 1);
  if (n > 0) slug = `${slug}-${n + 1}`;
  return slug;
}

function Children({ blocks, ctx }: { blocks: Block[]; ctx: Ctx }) {
  if (!blocks?.length) return null;
  return (
    <div className="border-l border-line pl-5 [&>*+*]:mt-[1.1em] mt-[0.6em]">
      <Blocks blocks={blocks} ctx={ctx} />
    </div>
  );
}

function ListItem({ block, ctx }: { block: Block; ctx: Ctx }) {
  return (
    <li data-blk={block.id}>
      {renderInline(block.content)}
      {block.children?.length > 0 && <Children blocks={block.children} ctx={ctx} />}
    </li>
  );
}

const TONE_META: Record<string, { icon: ReactNode; label: string }> = {
  info: { icon: <Info size={16} />, label: "Note" },
  success: { icon: <CheckCircle2 size={16} />, label: "Tip" },
  warning: { icon: <AlertTriangle size={16} />, label: "Warning" },
  danger: { icon: <OctagonAlert size={16} />, label: "Caution" },
};

/**
 * Carry the block id onto whatever element the block already renders as.
 *
 * cloneElement rather than a wrapper: the stylesheet leans on adjacent-
 * sibling selectors for vertical rhythm, and an extra div in the flow would
 * quietly change the spacing of every document. An attribute changes nothing
 * and is all the reading observer needs to find a passage.
 */
function tag(node: ReactNode, id: string): ReactNode {
  return isValidElement(node)
    ? cloneElement(node as ReactElement<Record<string, unknown>>, {
        "data-blk": id,
      })
    : node;
}

function Blocks({ blocks, ctx }: { blocks: Block[]; ctx: Ctx }) {
  const out: ReactNode[] = [];
  let i = 0;
  while (i < blocks.length) {
    const b = blocks[i];

    // Group consecutive steps into one connected sequence.
    if (b.type === "step") {
      const group: Block[] = [];
      while (i < blocks.length && blocks[i].type === "step") group.push(blocks[i++]);
      out.push(
        (<ol key={b.id} className="blk-steps">
          {group.map((g, n) => (
            <li key={g.id} data-blk={g.id} className="blk-steps-item">
              <span aria-hidden className="blk-steps-n">{n + 1}</span>
              <div className="blk-steps-body">
                <p className="blk-steps-title">{renderInline(g.content)}</p>
                {g.children?.length > 0 && (
                  <div className="[&>*+*]:mt-[0.9em]">
                    <Blocks blocks={g.children} ctx={ctx} />
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>)
      );
      continue;
    }

    // Group consecutive list items into a single list element.
    if (
      b.type === "bulletListItem" ||
      b.type === "numberedListItem" ||
      b.type === "checkListItem"
    ) {
      const type = b.type;
      const group: Block[] = [];
      while (i < blocks.length && blocks[i].type === type) group.push(blocks[i++]);
      if (type === "bulletListItem") {
        out.push(
          (<ul key={b.id}>
            {group.map((g) => (
              <ListItem key={g.id} block={g} ctx={ctx} />
            ))}
          </ul>)
        );
      } else if (type === "numberedListItem") {
        out.push(
          (<ol key={b.id}>
            {group.map((g) => (
              <ListItem key={g.id} block={g} ctx={ctx} />
            ))}
          </ol>)
        );
      } else {
        out.push(
          (<ul key={b.id}>
            {group.map((g) => (
              <li key={g.id} data-blk={g.id} className="checkitem">
                <input
                  type="checkbox"
                  disabled
                  defaultChecked={Boolean(g.props?.checked)}
                  className="mt-1 accent-[var(--accent)]"
                />
                <span
                  className={
                    g.props?.checked ? "text-muted line-through" : undefined
                  }
                >
                  {renderInline(g.content)}
                </span>
              </li>
            ))}
          </ul>)
        );
      }
      continue;
    }

    const marks = ctx.threads?.get(b.id);
    if (marks) {
      out.push(
        <div key={b.id} id={`blk-${b.id}`} data-blk={b.id} className="blk-anchored">
          <OneBlock block={b} ctx={ctx} />
          <a
            href={`#t-${b.id}`}
            data-thread-link={b.id}
            aria-label={`${marks.open + marks.resolved} comment thread${
              marks.open + marks.resolved === 1 ? "" : "s"
            } on this passage`}
            className={`blk-anchor-mark${marks.open === 0 ? " is-settled" : ""}`}
          >
            {marks.open + marks.resolved}
          </a>
        </div>
      );
    } else {
      out.push(<TaggedBlock key={b.id} block={b} ctx={ctx} />);
    }
    i++;
  }
  return <>{out}</>;
}

/**
 * OneBlock, with the block id attached to a real element.
 *
 * Two traps here, both found by watching a browser rather than by reading:
 *
 *   cloneElement on <OneBlock/> only sets a prop the component ignores, so
 *   the attribute never reaches the DOM. Cloning what it *rendered* does.
 *
 *   A fragment has no element to hang the attribute on, and wrapping it in a
 *   display:contents div does not help — such a div has no box at all, so an
 *   IntersectionObserver never sees it and the passage is silently never
 *   measured. Tag the fragment's first real child instead and the DOM is
 *   unchanged.
 */
function TaggedBlock({ block: b, ctx }: { block: Block; ctx: Ctx }) {
  return tagDeep(OneBlock({ block: b, ctx }), b.id);
}

function tagDeep(node: ReactNode, id: string): ReactNode {
  if (!isValidElement(node)) return node;
  if (node.type !== Fragment) return tag(node, id);
  const kids = ReactChildren.toArray(
    (node.props as { children?: ReactNode }).children
  );
  const first = kids.findIndex((k: ReactNode) => isValidElement(k));
  if (first === -1) return node;
  const next: ReactNode[] = [...kids];
  next[first] = tag(kids[first], id);
  return <>{next}</>;
}

function OneBlock({ block: b, ctx }: { block: Block; ctx: Ctx }) {
  const kids =
    b.children?.length > 0 ? <Children blocks={b.children} ctx={ctx} /> : null;

  switch (b.type) {
    case "heading": {
      const text = inlineText(b.content);
      const id = text ? headingId(ctx, text) : undefined;
      const level = Number(b.props?.level ?? 2);
      const H = level <= 1 ? "h1" : level === 2 ? "h2" : "h3";
      return (
        <>
          <H id={id} className="group/h relative">
            <a
              href={id ? `#${id}` : undefined}
              className="!no-underline !text-inherit"
            >
              {renderInline(b.content)}
            </a>
          </H>
          {kids}
        </>
      );
    }
    case "paragraph": {
      const empty = !inlineText(b.content).trim();
      if (empty && !kids) return null;
      return (
        <>
          <p>{renderInline(b.content)}</p>
          {kids}
        </>
      );
    }
    case "quote":
      return (
        <>
          <blockquote>{renderInline(b.content)}</blockquote>
          {kids}
        </>
      );
    case "codeBlock": {
      const code = inlineText(b.content);
      const language = String(b.props?.language ?? "");
      if (language === "mermaid") return <Mermaid source={code} />;
      const runnable = ctx.run && ctx.run.connectors.length > 0;
      const meta = {
        filename: b.props?.filename ? String(b.props.filename) : undefined,
        highlight: b.props?.highlight ? String(b.props.highlight) : undefined,
        lineNumbers:
          b.props?.lineNumbers === undefined
            ? undefined
            : Boolean(b.props.lineNumbers),
        wrap: Boolean(b.props?.wrap),
      };
      return (
        <div>
          <CodeBlock code={code} language={language} meta={meta} />
          {runnable && (
            <RunButton
              pageId={ctx.run!.pageId}
              blockId={b.id}
              connectors={ctx.run!.connectors}
              lastRun={ctx.run!.lastRuns[b.id] ?? null}
            />
          )}
        </div>
      );
    }
    case "table": {
      const content = b.content as TableContent | undefined;
      if (!content || Array.isArray(content)) return null;
      const rows = content.rows ?? [];
      if (!rows.length) return null;
      const [head, ...rest] = rows;
      const csvRows = rows.map((r) =>
        r.cells.map((c) => inlineText(cellContent(c)))
      );
      return (
        <div className="group/table relative overflow-x-auto rounded-lg border border-line-strong">
          <TableCsv rows={csvRows} name={`table-${b.id.slice(0, 6)}`} />
          <table>
            <thead>
              <tr>
                {head.cells.map((c, j) => (
                  <th key={j}>{renderInline(cellContent(c))}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rest.map((r, ri) => (
                <tr key={ri}>
                  {r.cells.map((c, j) => (
                    <td key={j}>{renderInline(cellContent(c))}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case "themeImage": {
      const url = String(b.props?.url ?? "");
      const darkUrl = String(b.props?.darkUrl ?? "");
      const caption = String(b.props?.caption ?? "");
      if (!url && !darkUrl) return null;
      return (
        <figure className="my-2">
          {url && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={url}
              alt={caption || "image"}
              loading="lazy"
              className={darkUrl ? "img-light-only" : undefined}
            />
          )}
          {darkUrl && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={darkUrl}
              alt={caption || "image"}
              loading="lazy"
              className={url ? "img-dark-only" : undefined}
            />
          )}
          {caption && (
            <figcaption className="mt-2 text-center text-sm text-muted">
              {caption}
            </figcaption>
          )}
        </figure>
      );
    }
    case "image": {
      const url = String(b.props?.url ?? "");
      const darkUrl = String(b.props?.darkUrl ?? "");
      const caption = String(b.props?.caption ?? "");
      if (!url) return null;
      return (
        <figure className="my-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={url}
            alt={caption || "image"}
            loading="lazy"
            className={darkUrl ? "img-light-only" : undefined}
          />
          {darkUrl && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={darkUrl}
              alt={caption || "image"}
              loading="lazy"
              className="img-dark-only"
            />
          )}
          {caption && (
            <figcaption className="mt-2 text-center text-sm text-muted">
              {caption}
            </figcaption>
          )}
        </figure>
      );
    }
    case "apiRequest": {
      const p = b.props ?? {};
      return (
        <ApiRequest
          method={String(p.method ?? "GET")}
          path={String(p.path ?? "/")}
          servers={String(p.servers ?? "")}
          params={String(p.params ?? "[]")}
          body={String(p.body ?? "")}
          auth={String(p.auth ?? "")}
        />
      );
    }
    case "video": {
      const url = String(b.props?.url ?? "");
      if (!url) return null;
      const embed = videoEmbedUrl(url);
      if (embed && isOffline()) {
        // A third-party player cannot load on a disconnected network. Say so
        // where the video would be, rather than leaving a frame that spins.
        return (
          <div className="rounded-xl border border-dashed border-line px-4 py-6 text-center">
            <p className="text-sm text-muted">
              This video is hosted outside this network and cannot be played
              here.
            </p>
            <p className="mt-1 break-all font-mono text-xs text-faint">{url}</p>
          </div>
        );
      }
      if (embed) {
        return (
          <div className="aspect-video overflow-hidden rounded-xl border border-line shadow-card">
            <iframe
              src={embed}
              title="Embedded video"
              className="h-full w-full"
              allow="accelerometer; encrypted-media; picture-in-picture; fullscreen"
              allowFullScreen
              loading="lazy"
              referrerPolicy="no-referrer"
            />
          </div>
        );
      }
      return (
        <video
          src={url}
          controls
          preload="metadata"
          className="w-full rounded-xl border border-line shadow-card"
        />
      );
    }
    case "audio": {
      const url = String(b.props?.url ?? "");
      if (!url) return null;
      return <audio src={url} controls className="w-full" />;
    }
    case "file": {
      const url = String(b.props?.url ?? "");
      const name = String(b.props?.name ?? "Download file");
      if (!url) return null;
      return (
        <a
          href={url}
          className="flex items-center gap-2 rounded-lg border border-line bg-surface px-4 py-3 text-sm !no-underline shadow-card transition-colors hover:border-line-strong"
        >
          ↓ {name}
        </a>
      );
    }
    case "callout": {
      const tone = String(b.props?.tone ?? "info");
      const meta = TONE_META[tone] ?? TONE_META.info;
      return (
        <aside className={`blk-callout blk-callout-${tone}`}>
          <span className="blk-callout-icon" aria-label={meta.label}>
            {meta.icon}
          </span>
          <div className="blk-callout-body">
            <p>{renderInline(b.content)}</p>
            {kids}
          </div>
        </aside>
      );
    }
    case "expandable":
      return (
        <details className="blk-details">
          <summary>{renderInline(b.content)}</summary>
          <div className="blk-details-body [&>*+*]:mt-[1.1em]">
            {b.children?.length > 0 && (
              <Blocks blocks={b.children} ctx={ctx} />
            )}
          </div>
        </details>
      );
    case "model3d": {
      const kind = String(b.props?.kind ?? "architecture") as ModelKind;
      const title = String(b.props?.title ?? "");
      return <Model3D kind={kind} title={title || undefined} />;
    }
    case "drawio": {
      const src = String(b.props?.src ?? "");
      if (!src) return null;
      return (
        <figure className="blk-drawio-published">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt="Diagram" loading="lazy" />
        </figure>
      );
    }
    case "math": {
      const tex = inlineText(b.content);
      if (!tex.trim()) return null;
      let html = "";
      try {
        html = katex.renderToString(tex, {
          displayMode: true,
          throwOnError: false,
        });
      } catch {
        return <pre className="blk-math-err">{tex}</pre>;
      }
      return (
        <div
          className="blk-math-display"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      );
    }
    default:
      // Unknown block type — render its text so nothing silently disappears.
      return (
        <>
          {inlineText(b.content) && <p>{renderInline(b.content)}</p>}
          {kids}
        </>
      );
  }
}

/** Server-rendered reader view of a BlockNote document. */
export function Renderer({
  blocks,
  dropCap = false,
  run,
  threads,
}: {
  blocks: Block[];
  dropCap?: boolean;
  run?: RunContext;
  threads?: Map<string, { open: number; resolved: number }>;
}) {
  const ctx: Ctx = { headingSeen: new Map(), run, threads };
  return (
    <div className={`reader${dropCap ? " reader-dropcap" : ""}`}>
      <Blocks blocks={blocks} ctx={ctx} />
    </div>
  );
}
