/**
 * Real DOM renders for SlotBadges. No mocks beyond what React itself does — we mount the
 * component in jsdom and assert on the rendered output.
 */
import { describe, it, expect } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { SlotBadges } from "../components/SlotBadges";

afterEach(cleanup);

describe("<SlotBadges>", () => {
  it("renders nothing when slots are undefined", () => {
    const { container } = render(<SlotBadges />);
    expect(container.querySelector(".slot-badges")).toBeNull();
  });

  it("renders all six beat names in canonical order", () => {
    render(<SlotBadges slots={{}} />);
    const badges = screen.getAllByText(/^(problem|solution|proof|portfolio|prior_results|cta)$/);
    expect(badges.map(b => b.textContent)).toEqual([
      "problem", "solution", "proof", "portfolio", "prior_results", "cta",
    ]);
  });

  it("marks slots with ≥20 chars of content as present", () => {
    render(
      <SlotBadges slots={{
        problem: "Twenty or more characters here",
        solution: "Plenty of solution text to count",
      }} />
    );
    expect(screen.getByText("problem")).toHaveClass("present");
    expect(screen.getByText("solution")).toHaveClass("present");
  });

  it("marks empty or short slots as missing", () => {
    render(
      <SlotBadges slots={{
        problem: "",
        solution: "short",   // < 20 chars
        cta: "Best, Isaiah", // exactly 12 chars, < 20
      }} />
    );
    expect(screen.getByText("problem")).toHaveClass("missing");
    expect(screen.getByText("solution")).toHaveClass("missing");
    expect(screen.getByText("cta")).toHaveClass("missing");
  });

  it("trims whitespace before deciding presence", () => {
    render(<SlotBadges slots={{ problem: "   \n\n  " }} />);
    expect(screen.getByText("problem")).toHaveClass("missing");
  });
});
