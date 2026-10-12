const backend = process.env.BACKEND_URL || "http://127.0.0.1:8000";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // The browser tests build into their own folder so they never disturb a running shop system.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  reactStrictMode: true,
  poweredByHeader: false,
  // The API's addresses end with "/"; do not let Next.js strip it.
  skipTrailingSlashRedirect: true,
  // The browser only ever talks to this website; /api/* is passed on to the backend.
  // That keeps sign-in cookies first-party and avoids cross-site requests.
  async rewrites() {
    return [
      // Keep the final "/" when passing the request on; the backend's addresses require it.
      { source: "/api/:path*/", destination: `${backend}/api/:path*/` },
      { source: "/api/:path*", destination: `${backend}/api/:path*` },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
