import { isRouteErrorResponse, Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";
import type { Route } from "./+types/root";
import "./app.css";
import { PendingBoundary } from "./components/pending";
import { THEME_BOOT_SCRIPT } from "./lib/theme";
import { IOS_STANDALONE_BOOT_SCRIPT } from "./lib/ios-standalone";

export const links: Route.LinksFunction = () => [
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Inter:wght@400..800&family=Space+Grotesk:wght@500..700&display=swap",
  },
  { rel: "icon", href: "/icon.svg", type: "image/svg+xml" },
  { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
  { rel: "manifest", href: "/manifest.webmanifest" },
];

export function meta() {
  return [{ title: "Stomp Tally" }, { name: "description", content: "Lowest under 10k pays. Daily step stakes for the crew." }];
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="theme-color" content="#09090c" />
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT + IOS_STANDALONE_BOOT_SCRIPT }} />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="Stomp Tally" />
        <Meta />
        <Links />
      </head>
      <body className="antialiased">
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <PendingBoundary><Outlet /></PendingBoundary>;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something broke";
  let details = "An unexpected error occurred.";
  let stack: string | undefined;
  if (isRouteErrorResponse(error)) {
    title = error.status === 404 ? "Not found" : `Error ${error.status}`;
    details = error.status === 404 ? "That page doesn't exist." : error.statusText || details;
  } else if (import.meta.env.DEV && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }
  return (
    <main className="mx-auto grid min-h-dvh max-w-md place-items-center p-6">
      <div className="card w-full p-8 text-center">
        <div className="text-4xl">🥴</div>
        <h1 className="mt-3 font-display text-2xl font-bold">{title}</h1>
        <p className="mt-2 text-muted">{details}</p>
        <a href="/" className="btn-primary mt-6">Back home</a>
        {stack && <pre className="mt-6 overflow-x-auto text-left text-xs text-muted">{stack}</pre>}
      </div>
    </main>
  );
}
