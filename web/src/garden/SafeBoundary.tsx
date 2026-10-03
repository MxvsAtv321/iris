// Keeps one broken image (a missing photo, a storage hiccup) from taking down
// the whole 3D scene. Whatever is inside just renders the fallback instead.
import { Component, type ReactNode } from "react";

type Props = { fallback?: ReactNode; onError?: (err: unknown) => void; children: ReactNode };

export class SafeBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(err: unknown) {
    console.warn("[garden] part of the scene failed to load", err);
    this.props.onError?.(err);
  }

  render() {
    return this.state.failed ? (this.props.fallback ?? null) : this.props.children;
  }
}
