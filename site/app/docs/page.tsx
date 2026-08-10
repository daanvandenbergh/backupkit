// app/docs/page.tsx - the /docs landing page (section cards). generateMetadata emits the index SEO.
import { DocsIndex } from "@daanvandenbergh/scribekit/react";
import { docs } from "./_docs";

export function generateMetadata() {
    return docs.indexMetadata();
}

export default function DocsIndexPage() {
    return <DocsIndex docs={docs} />;
}
