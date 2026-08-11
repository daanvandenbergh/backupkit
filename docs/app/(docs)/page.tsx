// app/(docs)/page.tsx - the site landing page (hero, section cards). generateMetadata emits
// the index SEO.
import { DocsIndex } from "@daanvandenbergh/scribekit/react";
import { docs } from "./_docs";
import { NavLink } from "./_docs-links";

export function generateMetadata() {
    return docs.indexMetadata();
}

export default function DocsIndexPage() {
    // `linkComponent={NavLink}` so the hero buttons and topic cards get the deployment base path -
    // they are otherwise raw <a href="/<slug>"> and 404 on a project site (`/<repo>/`).
    return (
        <DocsIndex
            docs={docs}
            linkComponent={NavLink}
            title="Automated, versioned backups over SSH"
            actions={[
                { label: "Get started", href: "/getting-started" },
                { label: "Configuration", href: "/configuration" },
            ]}
        />
    );
}
