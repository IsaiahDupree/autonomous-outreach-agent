import { describe, it, expect, beforeEach } from "vitest";
import * as control from "../src/services/process-control";

// Note: process-control uses module-level state, so we test the full lifecycle

describe("process-control", () => {
  beforeEach(() => {
    // Force back to running state between tests
    control.pause(); // ensure state is "paused" so resume() actually runs
    control.resume();
  });

  it("starts in running state", () => {
    expect(control.getState()).toBe("running");
    expect(control.isActive()).toBe(true);
  });

  it("pause → isActive returns false", () => {
    control.pause("test");
    expect(control.getState()).toBe("paused");
    expect(control.isActive()).toBe(false);
  });

  it("pause → resume → isActive returns true", () => {
    control.pause();
    control.resume();
    expect(control.getState()).toBe("running");
    expect(control.isActive()).toBe(true);
  });

  it("getFullState includes all fields", () => {
    const s = control.getFullState();
    expect(s).toHaveProperty("state");
    expect(s).toHaveProperty("uptime");
    expect(s).toHaveProperty("pid");
    expect(s).toHaveProperty("memory");
    expect(s).toHaveProperty("pausedSystems");
  });

  it("pauseSystem pauses individual subsystem", () => {
    control.pauseSystem("scanning");
    expect(control.isSystemPaused("scanning")).toBe(true);
    expect(control.isSystemPaused("submitting")).toBe(false);
    expect(control.isActive()).toBe(true); // agent still running
  });

  it("resumeSystem clears subsystem pause", () => {
    control.pauseSystem("submitting");
    control.resumeSystem("submitting");
    expect(control.isSystemPaused("submitting")).toBe(false);
  });

  it("global pause makes all subsystems paused", () => {
    control.pause();
    expect(control.isSystemPaused("scanning")).toBe(true);
    expect(control.isSystemPaused("submitting")).toBe(true);
    expect(control.isSystemPaused("anything")).toBe(true);
  });

  it("resume clears subsystem pauses too", () => {
    control.pauseSystem("scanning");
    control.pauseSystem("submitting");
    control.resume();
    expect(control.isSystemPaused("scanning")).toBe(false);
    expect(control.isSystemPaused("submitting")).toBe(false);
  });

  it("pause records reason and timestamp", () => {
    control.pause("maintenance");
    const s = control.getFullState();
    expect(s.reason).toBe("maintenance");
    expect(s.pausedAt).toBeTruthy();
  });
});
