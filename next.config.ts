import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async redirects() {
    return [
      // The game lives at /qwasm2/index.html. Redirect the bare directory
      // there so a user reaching "/qwasm2" lands on the canonical URL, keeping
      // the document's base directory at /qwasm2/ so the game's relative
      // assets (pak0.pak, index.js, *.wasm) resolve. A rewrite here would
      // leave the URL bare and break those relative loads. The trailing-slash
      // form "/qwasm2/" is already normalized to "/qwasm2" by Next.js itself.
      { source: "/qwasm2", destination: "/qwasm2/index.html", permanent: false },
    ];
  },
};

export default nextConfig;
