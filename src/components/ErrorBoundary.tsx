import { Component, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: unknown) => void;
}

interface ErrorBoundaryState {
  error: unknown;
}

/**
 * Catches render-time failures (e.g. canvas/WebGL breakdown, corrupt
 * template data surfacing during render) so one bad panel cannot blank
 * the whole streamer UI. Async faults (camera, inference, compose) are
 * handled in their own hooks — this is the last resort for sync render
 * errors.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: unknown): void {
    this.props.onError?.(error);
    console.error("UI error boundary caught:", error);
  }

  private handleRetry = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (this.state.error !== null) {
      if (this.props.fallback !== undefined) return this.props.fallback;
      const message =
        this.state.error instanceof Error
          ? this.state.error.message
          : String(this.state.error);
      return (
        <div className="viewfinder viewfinder--error" role="alert">
          <div className="viewfinder__error-icon">⚠️</div>
          <h2 className="viewfinder__error-title">Something went wrong</h2>
          <p className="viewfinder__error-hint">
            A panel crashed. Your camera stream is safe — try recovering this view.
          </p>
          <p className="viewfinder__error-detail">{message}</p>
          <button className="viewfinder__retry-btn" onClick={this.handleRetry}>
            Recover
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
