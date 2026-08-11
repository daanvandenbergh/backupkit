// app/(docs)/_docs-links.tsx - the MDX `a` override, so in-body prose links are client-side AND
// honour the deployment base path. Passed to DocsPage as `components={{ a: BodyLink }}`.
//
// A CLIENT module: `NavLink` below is the `next/link` re-export the client-side sections
// (`DocsTopicGrid` inside `DocsIndex`) take as `linkComponent` - a server component's own function
// cannot cross that boundary, a client reference can.
"use client";
import Link from "next/link";
import type { AnchorHTMLAttributes } from "react";

/** Renders an internal (`/`-rooted) link through `next/link` (base-path aware, client-side); leaves
 * hash links and external URLs as a plain `<a>`. */
export function BodyLink({ href = "", children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) {
    if (href.startsWith("/")) {
        return (
            <Link href={href} {...props}>
                {children}
            </Link>
        );
    }
    return (
        <a href={href} {...props}>
            {children}
        </a>
    );
}

/** `next/link` as a client reference, for the client-side sections that take a `linkComponent`. */
export { default as NavLink } from "next/link";
