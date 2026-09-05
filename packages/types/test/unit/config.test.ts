import { describe, expect, it } from "vitest";
import {
  AgentConfigSchema,
  BackendConfigSchema,
  DEFAULT_MAX_LIVE_FINGERPRINTS,
  DEFAULT_RING_BUFFER_BYTES,
  SdkConfigSchema,
} from "../../src/config.js";

describe("SdkConfigSchema", () => {
  it("accepts minimal valid config and fills in documented defaults", () => {
    const parsed = SdkConfigSchema.parse({ project: "hostel-os", apiKey: "sk_test_123" });
    expect(parsed.ringBufferBytes).toBe(DEFAULT_RING_BUFFER_BYTES);
    expect(parsed.maxLiveFingerprints).toBe(DEFAULT_MAX_LIVE_FINGERPRINTS);
    expect(parsed.environment).toBe("production");
    expect(parsed.agentSocketPath).toBe("/var/run/bugbuster/agent.sock");
  });

  it("accepts a fully-specified valid config, overriding every default", () => {
    const parsed = SdkConfigSchema.parse({
      project: "hostel-os",
      apiKey: "sk_test_123",
      environment: "staging",
      release: "2.8.1",
      agentSocketPath: "/tmp/bugbuster-test.sock",
      ringBufferBytes: 1024 * 1024,
      maxLiveFingerprints: 500,
      flushMaxBatchBytes: 64 * 1024,
      flushMaxDelayMs: 1000,
      shutdownFlushTimeoutMs: 500,
    });
    expect(parsed.environment).toBe("staging");
    expect(parsed.ringBufferBytes).toBe(1024 * 1024);
  });
});

describe("AgentConfigSchema", () => {
  it("accepts minimal valid config with a backend URL and API key", () => {
    const parsed = AgentConfigSchema.parse({
      backendUrl: "https://ingest.bugbuster.example",
      apiKey: "sk_agent_test",
    });
    expect(parsed.circuitBreakerFailureThreshold).toBe(5);
    expect(parsed.maxRetries).toBe(3);
  });
});

describe("BackendConfigSchema", () => {
  it("accepts minimal valid config with just a control DB URI", () => {
    const parsed = BackendConfigSchema.parse({ controlDbUri: "mongodb://localhost:27017" });
    expect(parsed.port).toBe(8080);
  });
});
