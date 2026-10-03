// Drop-in routing for the garden. If the team's app already has a router,
// mount <Garden /> at /garden there instead and drop this switch. Keep it
// lazy-loaded, since the 3D code is large and other pages don't need it.
import { Suspense, lazy } from "react";

const Garden = lazy(() => import("./garden/Garden").then((m) => ({ default: m.Garden })));

export default function App() {
  if (window.location.pathname.startsWith("/garden")) {
    return (
      <Suspense fallback={null}>
        <Garden />
      </Suspense>
    );
  }
  // Placeholder home page. Replace with the team's pages.
  return (
    <main>
      <h1>Iris</h1>
      <p>The memory garden lives at /garden?session= followed by a session id.</p>
    </main>
  );
}
