import { ImageResponse } from "next/og";
import { getPageBySlug, getSpaceBySlug } from "@/lib/data";

/**
 * The card a link unfurls into.
 *
 * Rendered here, by the instance, at request time — no external service and
 * no font fetch, so it works air-gapped like everything else. Private spaces
 * do not get cards: an unfurl is served to whoever's chat client asks, which
 * is exactly the audience a private space excludes. They get the wordmark
 * and nothing else.
 */

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "Octavo";

export default async function OgImage({
  params,
}: {
  params: Promise<{ space: string; page: string }>;
}) {
  const { space: spaceSlug, page: pageSlug } = await params;
  const space = getSpaceBySlug(spaceSlug);
  const page = space ? getPageBySlug(space.id, pageSlug) : null;
  const isPublic =
    space && page && page.published === 1 && space.visibility !== "private";

  const title = isPublic ? page.title : "Octavo";
  const kicker = isPublic ? space.name : "";

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 72,
          background: "#faf6ee",
          color: "#1f1b13",
          fontFamily: "serif",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column" }}>
          {kicker && (
            <div
              style={{
                fontSize: 28,
                letterSpacing: 4,
                textTransform: "uppercase",
                color: "#8a8272",
              }}
            >
              {kicker}
            </div>
          )}
          <div
            style={{
              marginTop: 24,
              fontSize: title.length > 60 ? 56 : 72,
              lineHeight: 1.15,
              fontWeight: 700,
              maxWidth: 1000,
            }}
          >
            {title.slice(0, 140)}
          </div>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ fontSize: 34, fontWeight: 700 }}>
            octavo<span style={{ color: "#b8401b" }}>.</span>
          </div>
          <div style={{ width: 220, height: 10, background: "#b8401b" }} />
        </div>
      </div>
    ),
    size
  );
}
