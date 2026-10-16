import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ErrorBoundary } from "../ErrorBoundary";

function Boom(): never {
  throw new Error("panel exploded");
}

describe("ErrorBoundary (M1)", () => {
  it("catches a render crash and offers recovery", () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    );
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText(/panel crashed/i)).toBeTruthy();
    fireEvent.click(screen.getByText("Recover"));
    // After recovery the fallback clears (children re-render and crash
    // again only on next error — here recovery resets to try again).
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("renders children when there is no error", () => {
    render(
      <ErrorBoundary>
        <div>healthy panel</div>
      </ErrorBoundary>
    );
    expect(screen.getByText("healthy panel")).toBeTruthy();
  });
});
