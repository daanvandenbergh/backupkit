/**
 * scribekit-hero :: hero settings (SEED)
 * ===============================
 * The skill copies this file to your blog content dir as `hero.settings.js`, then recolours the
 * palette and swaps the brand identity to match your site (see the /scribekit-hero skill). It is the ONE place
 * your project defines how heroes look; the design/layout lives in the skill's `hero.js`, and each
 * post's text lives in its own `<slug>/hero.js`. Edit freely, then run `regenerate-heroes` to
 * re-render every hero with your changes.
 *
 * THIS FILE, not the component, is where a project's look belongs - including `brand.css`, a raw
 * stylesheet appended after the component's own so it wins at equal specificity. Between the brand
 * fields and that CSS, almost nothing justifies editing `hero.js`; and `hero.js` must never be edited
 * through `node_modules`, where the next install reverts it. See the skill's "Customising the
 * component" section.
 *
 * Exports:
 *   - brand     - font, badge/logo, eyebrow, texture, extra CSS, and default byline shared by every hero.
 *   - gradients - the named background options a post picks from (6 techniques over one palette).
 */

/**
 * The brand palette: `R, G, B` triplets, reused opaque (`rgb(...)`) and as same-hue zero-alpha
 * fades (`rgba(..., 0)`) so gradients never band. Recolour these to your site's tokens - keep one
 * distinct hue per slot and a dark `violetDeep` so white hero text stays legible.
 *
 * @prop c.pink {string} Light accent hue that blooms in from a corner (`R, G, B`).
 * @prop c.lilac {string} Light accent hue that blooms in from a corner (`R, G, B`).
 * @prop c.peach {string} Light accent hue that blooms in from a corner (`R, G, B`).
 * @prop c.blue {string} Light accent hue that blooms in from a corner (`R, G, B`).
 * @prop c.violet {string} The base ramp's lightest violet (`R, G, B`).
 * @prop c.violetMid {string} The base ramp's mid violet (`R, G, B`).
 * @prop c.violetDeep {string} The base ramp's darkest violet (`R, G, B`); keep it dark so white text stays legible.
 */
const c = {
    pink: "86, 200, 196", // mint
    lilac: "104, 174, 226", // sky
    peach: "120, 210, 186", // sea green (the "safe" hue)
    blue: "78, 186, 226", // cyan
    violet: "38, 176, 178", // base ramp - teal
    violetMid: "24, 108, 150", // base ramp - deep blue-teal
    violetDeep: "14, 46, 92", // base ramp - navy; kept dark so white text stays legible
};

/**
 * Wraps a palette triplet as an opaque `rgb(...)` colour.
 * @param t {string} An `R, G, B` triplet (e.g. `"143, 107, 255"`).
 * @returns {string} The `rgb(R, G, B)` CSS colour.
 */
const rgb = (t) => `rgb(${t})`;
/**
 * Wraps a palette triplet as a same-hue, zero-alpha `rgba(..., 0)` fade (banding-free).
 * @param t {string} An `R, G, B` triplet (e.g. `"143, 107, 255"`).
 * @returns {string} The `rgba(R, G, B, 0)` CSS colour.
 */
const fade = (t) => `rgba(${t}, 0)`;

/**
 * Brand identity baked into every hero (shared by every post). Recolour/rebrand this to your project.
 *
 * @prop brand.font {object} The webfont applied to all hero text.
 * @prop brand.font.family {string} CSS `font-family` name to apply (e.g. `"Space Grotesk"`).
 * @prop brand.font.url {string} Stylesheet URL that serves the family (e.g. a Google Fonts link); loaded once per render.
 * @prop brand.badge {string|object} Your logo/mark for the eyebrow badge - EITHER an inline SVG/glyph
 *     string, OR a `{ src }` image resolved relative to THIS file so it loads in the headless render,
 *     e.g. `{ src: new URL("../public/logo/logo-rounded.png", import.meta.url).href }`.
 * @prop brand.badge.src {string} Image URL, when `badge` is an object.
 * @prop brand.badge.bare {boolean} Drop the badge's white tile so the mark sits straight on the gradient.
 *     For a mark already coloured for the stage (a white symbol on a dark gradient), where the tile would
 *     hide it or read as a second shape. The mark keeps its aspect ratio, so a non-square symbol is not
 *     cropped. Applies to the badge only - the byline avatar keeps its round frame.
 * @prop brand.accent {string} `R, G, B` triplet for an inline-SVG badge glyph's colour (ignored for image logos).
 * @prop brand.texture {object} Optional texture over every gradient - what stops a large flat gradient
 *     reading as a printed sheet. Omit for none.
 * @prop brand.texture.dots {number} Opacity of a 26px white dot grid, masked to gather top-right, away
 *     from the copy (e.g. `0.13`). Omit or `0` for none.
 * @prop brand.texture.grain {number} Opacity of a fractal-noise grain (e.g. `0.06`). Doubles as dither -
 *     it hides the banding a multi-stop ramp shows across 1200px. Omit or `0` for none.
 * @prop brand.css {string} Your own CSS, appended after the component's stylesheet so it wins at equal
 *     specificity - the supported way to restyle a hero without forking the component. Selectors are the
 *     component's own: `.stage`, `.content`, `.eyebrow`, `.badge`, `.title`, `.subtitle`, `.byline`.
 *     Omit unless you need it.
 * @prop brand.eyebrow {string} The uppercase site/brand name shown above the title.
 * @prop brand.byline {object} Default byline fields. Optional. A hero shows a byline only when its post
 *     defines `byline`; this default then fills in any field the post omits (e.g. a shared avatar). A post
 *     with no `byline` renders without one, so setting this never forces a byline onto every hero.
 * @prop brand.byline.name {string} Author display name shown next to the avatar.
 * @prop brand.byline.role {string} Author role/title shown under the name.
 * @prop brand.byline.avatar {string|object} Author avatar shown in the byline - an inline SVG string, OR a
 *     `{ src }` image resolved like `badge` (e.g. `{ src: new URL("../public/assets/authors/jane.svg", import.meta.url).href }`).
 *     Falls back to the brand `badge` when omitted.
 * @prop brand.byline.avatar.src {string} Image URL, when `avatar` is an object.
 */
export const brand = {
    font: { family: "Space Grotesk", url: "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&display=swap" },
    // The project mark: a sync ring (push/pull) around a stack of snapshots fading into history.
    // `bare` because the mark is already white - the default white tile would swallow it.
    badge: { src: new URL("../../../assets/logo/logo.svg", import.meta.url).href, bare: true },
    accent: "24, 108, 150",
    eyebrow: "BACKUPKIT",
    texture: { dots: 0.12, grain: 0.06 },
};

/**
 * The gradient options a post picks from. The 6 recipes are different constructions over the SAME
 * palette slots, so the family stays cohesive when you recolour the palette. Tune a recipe's stop
 * positions here if needed; keep the palette mapping consistent across all six.
 *
 * @prop gradients {object[]} The named background options (6 of them); a post picks one by `name`.
 * @prop gradients[].name {string} The gradient's identifier - one of `radial-mesh`, `diagonal-ribbon`,
 *     `aurora-glow`, `soft-sweep`, `horizon-glow`, `veil`.
 * @prop gradients[].css {string} A full CSS `background` value built from the palette above.
 */
export const gradients = [
    {
        name: "radial-mesh",
        css: [
            `radial-gradient(120% 120% at 12% 8%, ${rgb(c.pink)} 0%, ${fade(c.pink)} 46%)`,
            `radial-gradient(90% 90% at 88% -6%, ${rgb(c.lilac)} 0%, ${fade(c.lilac)} 42%)`,
            `radial-gradient(120% 120% at 96% 96%, ${rgb(c.peach)} 0%, ${fade(c.peach)} 46%)`,
            `radial-gradient(120% 120% at 4% 104%, ${rgb(c.blue)} 0%, ${fade(c.blue)} 48%)`,
            `linear-gradient(135deg, ${rgb(c.violet)} 0%, ${rgb(c.violetMid)} 60%, ${rgb(c.violetDeep)} 100%)`,
        ].join(", "),
    },
    {
        name: "diagonal-ribbon",
        css: `linear-gradient(118deg, ${rgb(c.violetDeep)} 0%, ${rgb(c.violetMid)} 14%, ${rgb(c.violet)} 28%, ${rgb(c.lilac)} 46%, ${rgb(c.pink)} 64%, ${rgb(c.peach)} 82%, ${rgb(c.blue)} 100%)`,
    },
    {
        name: "aurora-glow",
        css: [
            `radial-gradient(120% 100% at 50% -18%, ${rgb(c.lilac)} 0%, ${fade(c.lilac)} 55%)`,
            `radial-gradient(100% 90% at 92% 112%, ${rgb(c.pink)} 0%, ${fade(c.pink)} 52%)`,
            `radial-gradient(90% 90% at 8% 104%, ${rgb(c.blue)} 0%, ${fade(c.blue)} 48%)`,
            `linear-gradient(160deg, ${rgb(c.violet)} 0%, ${rgb(c.violetMid)} 55%, ${rgb(c.violetDeep)} 100%)`,
        ].join(", "),
    },
    {
        name: "soft-sweep",
        css: `linear-gradient(140deg, ${rgb(c.violetDeep)} 0%, ${rgb(c.violet)} 30%, ${rgb(c.lilac)} 56%, ${rgb(c.pink)} 80%, ${rgb(c.peach)} 100%)`,
    },
    {
        name: "horizon-glow",
        css: [
            `radial-gradient(130% 90% at 100% 100%, ${rgb(c.peach)} 0%, ${fade(c.peach)} 40%)`,
            `radial-gradient(120% 100% at 100% 100%, ${rgb(c.pink)} 0%, ${fade(c.pink)} 55%)`,
            `radial-gradient(110% 90% at 0% 0%, ${rgb(c.blue)} 0%, ${fade(c.blue)} 46%)`,
            `linear-gradient(120deg, ${rgb(c.violetMid)} 0%, ${rgb(c.violet)} 45%, ${rgb(c.lilac)} 100%)`,
        ].join(", "),
    },
    {
        name: "veil",
        css: [
            `radial-gradient(120% 100% at 8% 10%, ${rgb(c.blue)} 0%, ${fade(c.blue)} 44%)`,
            `radial-gradient(120% 110% at 100% 30%, ${rgb(c.pink)} 0%, ${fade(c.pink)} 50%)`,
            `radial-gradient(110% 100% at 55% 115%, ${rgb(c.peach)} 0%, ${fade(c.peach)} 48%)`,
            `linear-gradient(125deg, ${rgb(c.violet)} 0%, ${rgb(c.violetMid)} 55%, ${rgb(c.violetDeep)} 100%)`,
        ].join(", "),
    },
];
