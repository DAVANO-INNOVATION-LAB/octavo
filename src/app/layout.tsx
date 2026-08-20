import type { Metadata } from "next";
import { Geist, Geist_Mono, Fraunces } from "next/font/google";
import "./globals.css";
import "katex/dist/katex.min.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
  axes: ["opsz", "SOFT", "WONK"],
});

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
      className={`${geistSans.variable} ${geistMono.variable} ${fraunces.variable} h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
