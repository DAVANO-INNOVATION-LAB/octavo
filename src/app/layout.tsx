import type { Metadata } from "next";
import "./fonts.css";
import "./globals.css";
import "katex/dist/katex.min.css";
import { SiteFooter } from "@/components/SiteFooter";
import { bootstrapScript } from "@/lib/runtime-config";

export const metadata: Metadata = {
  title: {
    default: "Octavo",
    template: "%s · Octavo",
  },
  description:
    "Open-source documentation that reads like a book. Write like Notion, publish like a press.",
};

const themeInit = `(function(){try{
var d=document.documentElement;
var t=localStorage.getItem("octavo-theme");
if(t==="dark"||t==="light"){d.setAttribute("data-theme",t)}
var SEASONS={9:"hallows",10:"harvest",11:"yuletide",0:"meridian"};
var season=SEASONS[new Date().getMonth()];
var seasonalOff=localStorage.getItem("octavo-seasonal")==="off";
var p=localStorage.getItem("octavo-palette");
var PALETTES=["slate","forest","indigo","rosewood","graphite"];
if(season&&!seasonalOff){d.setAttribute("data-palette",season)}
else if(p&&PALETTES.indexOf(p)>=0){d.setAttribute("data-palette",p)}
}catch(e){}})()`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className="h-full antialiased"
    >
      <head>
        {/* Runtime config and the local Excalidraw asset path must both be set
            before any client bundle evaluates, or Excalidraw resolves its
            fonts against its CDN fallback. */}
        <script dangerouslySetInnerHTML={{ __html: bootstrapScript() }} />
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body className="min-h-full flex flex-col">
        {/* First in the tab order on every page. Without it a keyboard reader
            tabs through the whole header and sidebar to reach the article,
            on every single page, forever. */}
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        {children}
        <SiteFooter />
      </body>
    </html>
  );
}
