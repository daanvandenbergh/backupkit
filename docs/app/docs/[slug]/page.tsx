// app/docs/[slug]/page.tsx - one static page per doc. Single-locale (flat /docs/<slug>).
import Link from "next/link";
import { DocsPage } from "@daanvandenbergh/scribekit/react";
import { docs } from "../_docs";
import { BodyLink } from "../_docs-links";
import { BaseImg } from "../_docs-image";

/** Unknown slugs 404 at the router instead of rendering on demand. */
export const dynamicParams = false;

/** Prerender one static page per doc. */
export function generateStaticParams() {
    return docs.getDocSlugs().map((slug) => ({ slug }));
}

/** Per-page SEO metadata (canonical, OG, JSON-LD source); falls back to a not-found title. */
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
    const { slug } = await params;
    try {
        return docs.docMetadata(docs.getDoc(slug));
    } catch {
        return { title: "Page not found" };
    }
}

export default async function DocPage({ params }: { params: Promise<{ slug: string }> }) {
    const { slug } = await params;
    // `imgComponent={BaseImg}` and `components={{ a: BodyLink }}` make the hero image and in-body prose
    // links base-path aware, so they resolve on a project site (`/<repo>/`) as well as at the root -
    // they are otherwise raw <img>/<a> that Next never prefixes.
    return <DocsPage docs={docs} slug={slug} linkComponent={Link} imgComponent={BaseImg} components={{ a: BodyLink }} />;
}
