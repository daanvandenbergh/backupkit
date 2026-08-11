// app/(docs)/page.tsx - the site landing page (hero, intro, section cards). generateMetadata emits
// the index SEO.
import { DocsIndex } from "@daanvandenbergh/scribekit/react";
import { docs } from "./_docs";
import { NavLink } from "./_docs-links";

/** The topic-card accent cycle: the brand ramp, in place of the package's indigo/violet default. */
const ACCENTS = ["#26b0b2", "#186c96", "#0e2e5c", "#4ebae2"];

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
            accents={ACCENTS}
            actions={[
                { label: "Get started", href: "/getting-started" },
                { label: "Configuration", href: "/configuration" },
            ]}
        >
            {/* The "what is this" band, between the hero and the topic grid. */}
            <section className="scribekit-prose">
                <p>
                    <strong>Backupkit</strong> is a thin, dependency-free TypeScript layer over <code>rsync</code>. Every run writes a dated
                    snapshot whose unchanged files are hard-linked against the previous one, so keeping months of history costs close to
                    nothing, and its scheduler runs each target on its own interval and prunes old snapshots on a GFS retention policy under
                    systemd or launchd.
                </p>
                <p>
                    Targets run in either direction. In a <strong>pull</strong> target - the safe default - the backup server reaches out and
                    fetches from the source, so a compromised source host holds no credential that reaches the archive; a{" "}
                    <strong>push</strong> target lets the source initiate instead, with its key jailed to a forced <code>rsync</code> command.
                    Snapshots are atomic and locked per destination, and <code>rsync</code>/<code>ssh</code> are always spawned as argv arrays,
                    never a shell string.
                </p>
                <p>
                    Install it with <code>npm install -g @daanvandenbergh/backupkit</code> (Node 20+, rsync 3.2.5+ and ssh on both hosts), then
                    follow <NavLink href="/getting-started">Getting Started</NavLink>.
                </p>
            </section>
        </DocsIndex>
    );
}
