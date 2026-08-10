// app/docs/_docs-image.tsx - a base-path-aware hero <img>, passed to DocsPage as `imgComponent`.
//
// The page hero (`image:` front-matter) renders as a raw <img src="/assets/...">. On a project site
// (`/<repo>/` base path) that raw path is NOT prefixed by Next (and `next/image` passes it through
// unchanged under `images.unoptimized`, which a static export requires), so it 404s. This prepends the
// same base path the config uses (from NEXT_PUBLIC_BASE_PATH), so heroes resolve under a subpath too.
// Empty base path (root hosting) -> src is unchanged.
import type { ImgHTMLAttributes } from "react";

const BASE = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/$/, "");

/** Renders the hero image, prefixing a root-relative src with the deployment base path. */
export function BaseImg({ src = "", ...props }: ImgHTMLAttributes<HTMLImageElement>) {
    const resolved = typeof src === "string" && src.startsWith("/") ? `${BASE}${src}` : src;
    return <img src={resolved} {...props} />;
}
