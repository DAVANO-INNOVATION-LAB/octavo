import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["better-sqlite3"],
  // Octavo serves uploads and vendored assets directly and uses no
  // next/image anywhere, so the optimizer would only ever sit there
  // answering requests nothing in the product makes. Off, it is not part
  // of the surface a self-hoster has to reason about.
  images: { unoptimized: true },
};

export default nextConfig;
