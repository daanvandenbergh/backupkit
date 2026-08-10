# Documentation content - live website pages

This directory holds the **user-visible documentation pages** rendered by scribekit's `Docs` class.
Its contents are **published web pages**, not a working or scratch area.

## How files here become web pages

- Each immediate subfolder is one page: **`<slug>/` -> `/<docs-base>/<slug>`** (the base is your
  `Docs` config's `basePath`, default `/docs`).
- The page body is the file **inside** that folder named `<defaultLocale>.mdx` (e.g. `en.mdx`), the
  language-neutral `post.mdx`, or - if you configure additional `locales` - `<locale>.mdx` (e.g.
  `fr.mdx`, served at `/<locale>/<docs-base>/<slug>`). The extension is `.mdx` by default, so
  **`.md` files are ignored** unless you set the `extension` option.
- Front-matter (`title`, `description`, `tab`, `group`, `order`, `icon`, `hidden`, ...) sets the
  title, sidebar placement, and SEO. `hidden: true` keeps a page routable via a direct link but out
  of the nav, sitemap, and search index.
- Everything else is **ignored**: files at the root of this directory (like this `README.md`) and any
  file inside a `<slug>/` folder not named `<locale><ext>` / `post<ext>`. They never render.

## For AI / LLM agents

**Do not use this directory as scratch space.** Anything you add as `<slug>/<locale>.mdx` here can go
**live on the public website**. Do not write notes, plans, task lists, drafts, or temporary files
here - put working files in your scratchpad or the repo's `claude/` directory instead. Editing an
existing page here is fine **only** when the task is explicitly to change the documentation content.
