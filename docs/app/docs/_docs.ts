// app/docs/_docs.ts - the single configured Docs instance the routes read from.
import { Docs } from "@daanvandenbergh/scribekit";

export const docs = new Docs({
    contentDir: "./docs", // folder of <slug>/en.mdx pages, resolved against the app root (process.cwd())
    siteUrl: "https://daanvandenbergh.github.io/backupkit", // GitHub Pages project-site origin
    brandName: "Backupkit",
    // Tab and group order for a stable sidebar. Fill from the corpus front-matter (`tab` / `group`).
    tabs: ["Guide", "Reference"],
    groups: ["Start", "Concepts", "Operate", "Configuration", "CLI"],
});
