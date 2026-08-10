// app/docs/layout.tsx - wraps every docs route in the persistent shell. Server component: it builds
// the nav tree at build time and hands the serializable result to the client chrome.
import type { ReactNode } from "react";
import { docs } from "./_docs";
import { DocsChrome } from "./_docs-chrome";

export default function DocsLayout({ children }: { children: ReactNode }) {
    return <DocsChrome nav={docs.getNavTree()}>{children}</DocsChrome>;
}
