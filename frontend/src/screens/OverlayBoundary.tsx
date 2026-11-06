// Keeps a failure of the 3D camera overlay (a render error, the chunk failing to load) from taking the scan
// screen down: the overlay is dropped, the screen is told, and the plain 2D drawing takes over.
import { Component, type ReactNode } from "react";

interface Props {
  onError: (err: unknown) => void;
  children: ReactNode;
}

export class OverlayBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(err: unknown) {
    try {
      this.props.onError(err);
    } catch (e) {
      console.error("overlay fallback failed", e);
    }
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}
