// app/(docs)/_docs.ts - the single configured Docs instance the routes read from.
import { Docs } from "@daanvandenbergh/scribekit";

export const docs = new Docs({
    contentDir: "./content", // folder of <slug>/en.mdx pages, resolved against the app root (process.cwd())
    basePath: "/", // the site IS the docs: pages serve at /<slug>, not /docs/<slug>. Keep in step with the route group.
    siteUrl: "https://daanvandenbergh.github.io/backupkit", // GitHub Pages project-site origin
    brandName: "Backupkit",
    // The site description: the index hero's subtitle AND the SEO meta description, so keep it one
    // sentence and under ~160 characters.
    description:
        "Automated, versioned backups over SSH - a dependency-free TypeScript layer over rsync, with dated snapshots, hard-linked history, and push or pull targets.",
    // Tab and group order for a stable sidebar. Fill from the corpus front-matter (`tab` / `group`).
    tabs: ["Guide", "Reference"],
    groups: ["Start", "Concepts", "Operate", "Configuration", "CLI"],
});
