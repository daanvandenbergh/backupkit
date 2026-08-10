// app/layout.tsx - the root layout. Imports the package stylesheet (the docs UI) and the local reset,
// then renders the document shell every route lives in.
import type { ReactNode } from "react";
import "@daanvandenbergh/scribekit/styles.css";
import "./globals.css";

export default function RootLayout({ children }: { children: ReactNode }) {
    return (
        <html lang="en">
            <body>{children}</body>
        </html>
    );
}
