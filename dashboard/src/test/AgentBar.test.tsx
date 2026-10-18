/**
 * Real DOM render of AgentBar. Stubs fetch so we can assert what the bar shows for each agent
 * state and that pause/resume hits the right endpoint.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentBar } from "../components/AgentBar";

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
  mockFetch.mockReset();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  cleanup();
});

function stateResponse(state: string) {
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify({ state })),
    json: () => Promise.resolve({ state }),
  };
}

describe("<AgentBar>", () => {
  it("renders 'Running' with the running dot when agent state is running", async () => {
    mockFetch.mockResolvedValue(stateResponse("running"));
    const { container } = render(<AgentBar />);
    await waitFor(() => expect(screen.getByText("Running")).toBeInTheDocument());
    const wrapper = container.querySelector(".agent-status");
    expect(wrapper).toHaveClass("running");
  });

  it("renders 'Paused' with the paused class when agent state is paused", async () => {
    mockFetch.mockResolvedValue(stateResponse("paused"));
    const { container } = render(<AgentBar />);
    await waitFor(() => expect(screen.getByText("Paused")).toBeInTheDocument());
    expect(container.querySelector(".agent-status")).toHaveClass("paused");
  });

  it("renders 'Stopped' and disables the toggle button when agent is stopped", async () => {
    mockFetch.mockResolvedValue(stateResponse("stopped"));
    render(<AgentBar />);
    await waitFor(() => expect(screen.getByText("Stopped")).toBeInTheDocument());
    const btn = screen.getByRole("button");
    expect(btn).toBeDisabled();
  });

  it("clicking Pause when running issues POST /api/agent/pause then re-fetches state", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mockFetch.mockResolvedValueOnce(stateResponse("running"));   // initial load
    mockFetch.mockResolvedValueOnce(stateResponse("paused"));    // POST pause
    mockFetch.mockResolvedValueOnce(stateResponse("paused"));    // refresh after pause

    render(<AgentBar />);
    await waitFor(() => expect(screen.getByText("Pause")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /pause/i }));

    const calls = mockFetch.mock.calls;
    const pauseCall = calls.find(c => c[0] === "/api/agent/pause");
    expect(pauseCall, "expected a POST to /api/agent/pause").toBeDefined();
    expect(pauseCall![1].method).toBe("POST");

    await waitFor(() => expect(screen.getByText("Resume")).toBeInTheDocument());
  });

  it("clicking Resume when paused issues POST /api/agent/resume", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mockFetch.mockResolvedValueOnce(stateResponse("paused"));
    mockFetch.mockResolvedValueOnce(stateResponse("running"));
    mockFetch.mockResolvedValueOnce(stateResponse("running"));

    render(<AgentBar />);
    await waitFor(() => expect(screen.getByText("Resume")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /resume/i }));

    const resumeCall = mockFetch.mock.calls.find(c => c[0] === "/api/agent/resume");
    expect(resumeCall).toBeDefined();
    expect(resumeCall![1].method).toBe("POST");
  });

  it("treats a fetch failure as a stopped state without crashing", async () => {
    mockFetch.mockRejectedValue(new Error("connect ECONNREFUSED"));
    render(<AgentBar />);
    await waitFor(() => expect(screen.getByText("Stopped")).toBeInTheDocument());
  });
});
