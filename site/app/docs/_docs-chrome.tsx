// app/docs/_docs-chrome.tsx - the persistent, interactive docs shell (client component).
"use client";
import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { DocsSearchProvider, DocsNavbar, DocsTabs, DocsSidebar } from "@daanvandenbergh/scribekit/react";
import type { NavTree } from "@daanvandenbergh/scribekit";

export function DocsChrome({ nav, children }: { nav: NavTree; children: ReactNode }) {
    const activePath = usePathname();
    return (
        <DocsSearchProvider nav={nav} linkComponent={Link}>
            <div className="scribekit-docs">
                {/* DocsNavbar renders the centered ⌘K search itself (showSearch defaults true).
                    Put your own buttons (auth, links, theme) in `actions=[...]` - not another search. */}
                <DocsNavbar brandName="Backupkit" docsText="Docs" linkComponent={Link} />
                <DocsTabs nav={nav} activePath={activePath} linkComponent={Link} />
                <div className="scribekit-docs-body">
                    <DocsSidebar nav={nav} activePath={activePath} linkComponent={Link} />
                    <main className="scribekit-docs-main">{children}</main>
                </div>
            </div>
        </DocsSearchProvider>
    );
}
