import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  message: string;
}

// App-root error boundary. Before this existed, a render crash (e.g. an OOM
// during batch parsing) left the tab to silently reload to an empty home
// screen with no explanation. Now the crash is caught and a recovery card is
// shown instead. Critically, submitted batch jobs are durably stored in Neon
// (see the batch_jobs table), so a crash here never loses or orphans a billed
// batch — the card says so explicitly to stop the user from re-submitting.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, message: "" };

  static getDerivedStateFromError(error: unknown): State {
    return {
      hasError: true,
      message: error instanceof Error ? error.message : "Unexpected error",
    };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("[error-boundary]", error, info.componentStack);
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6">
        <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 text-card-foreground shadow-sm">
          <h1 className="text-lg font-semibold">Something went wrong</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            The page hit an unexpected error and stopped rendering.{" "}
            <strong className="font-medium text-foreground">
              Your submitted batch jobs are saved on the server and were not
              lost
            </strong>{" "}
            — reloading will bring them back, and any in-flight results will keep
            loading. There is no need to re-submit.
          </p>
          {this.state.message ? (
            <p className="mt-3 break-words rounded bg-muted p-2 font-mono text-xs text-muted-foreground">
              {this.state.message}
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-4 inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
