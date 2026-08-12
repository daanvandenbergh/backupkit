// next.config.mjs - copy to the Next app root.
//
// The deploy workflow sets NEXT_PUBLIC_BASE_PATH from GitHub's `configure-pages` `base_path` output:
// empty for a custom domain / user-org site, "/<repo>" for a project site. The app reads the SAME var
// (a) here, to set Next's basePath/assetPrefix (so routes, next/link, and _next assets get the prefix),
// and (b) in `_docs-image.tsx`, so the hero's raw /assets/... src gets the prefix too. Unset (local
// build) -> root-served.
const base = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/$/, "");

/** @type {import('next').NextConfig} */
export default {
    output: "export",
    // Must match the Docs/Blog instance's `trailingSlash` (both default to true): this writes
    // <slug>/index.html, so the host serves /slug/ and redirects /slug to it.
    trailingSlash: true,
    images: { unoptimized: true },
    // The repo root also carries a lockfile (the library); pin the workspace root to this app
    // so the build never infers the parent directory.
    turbopack: { root: import.meta.dirname },
    ...(base ? { basePath: base, assetPrefix: base } : {}),
};
