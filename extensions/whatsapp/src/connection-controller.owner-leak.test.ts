// Regression: a WhatsApp run that ends after a bounded credential-drain timeout must not pin
// the in-process connection-owner lease for the lifetime of the Gateway process.
//
// This file intentionally does NOT mock ./connection-owner.js: it exercises the real
// process-local owner reservation plus the real file lock so the leak is observable exactly
// as in production (a successor run is refused with "Another process owns this ...").
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WhatsAppConnectionController } from "./connection-controller.js";
import { acquireWhatsAppStandaloneConnectionOwner } from "./connection-owner.js";
import { createAcceptedWhatsAppSendResult } from "./inbound/send-result.test-helper.js";
import {
  createWaSocket,
  waitForCredsSaveQueueWithTimeout,
  waitForWaConnection,
} from "./session.js";

vi.mock("./session.js", async () => {
  const actual = await vi.importActual<typeof import("./session.js")>("./session.js");
  return {
    ...actual,
    createWaSocket: vi.fn(),
    waitForWaConnection: vi.fn(),
    waitForCredsSaveQueueWithTimeout: vi.fn(async () => "drained" as const),
  };
});

const runtimeContextMocks = vi.hoisted(() => ({
  channelRuntime: { runtimeContexts: {} },
  register: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/channel-runtime-context", () => {
  return {
    getChannelRuntimeContext: vi.fn(),
    registerChannelRuntimeContext: runtimeContextMocks.register,
  };
});

vi.mock("./runtime.js", () => ({
  getWhatsAppChannelRuntime: () => runtimeContextMocks.channelRuntime,
}));

const createWaSocketMock = vi.mocked(createWaSocket);
const waitForWaConnectionMock = vi.mocked(waitForWaConnection);
const waitForCredsSaveQueueWithTimeoutMock = vi.mocked(waitForCredsSaveQueueWithTimeout);

function createListenerStub() {
  return {
    sendMessage: vi.fn(async () => createAcceptedWhatsAppSendResult("text", "ok")),
    sendPoll: vi.fn(async () => createAcceptedWhatsAppSendResult("poll", "ok")),
    sendReaction: vi.fn(async () => createAcceptedWhatsAppSendResult("reaction", "ok")),
    sendComposingTo: vi.fn(async () => {}),
  };
}

function createConnectedSocket() {
  let closed = false;
  return {
    end: vi.fn(async () => {
      closed = true;
    }),
    ws: {
      close: vi.fn(async () => {
        closed = true;
      }),
      get isClosed() {
        return closed;
      },
    },
  };
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return true;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  return await predicate();
}

describe("WhatsApp owner lease release after a failing run", () => {
  let authParent: string;
  let authDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    runtimeContextMocks.register.mockReturnValue({ dispose: vi.fn() });
    waitForCredsSaveQueueWithTimeoutMock.mockReset().mockResolvedValue("drained");
    authParent = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-wa-leak-"));
    authDir = path.join(authParent, "auth");
    await fs.mkdir(authDir);
  });

  afterEach(async () => {
    await fs.rm(authParent, { recursive: true, force: true });
  });

  it("releases the in-process owner so a successor run is not refused", async () => {
    const sock = createConnectedSocket();
    createWaSocketMock.mockResolvedValueOnce(sock as never);
    waitForWaConnectionMock.mockResolvedValueOnce(undefined);
    // First drain after the disconnect times out (the 408 storm aborts the creds write);
    // a later attempt drains cleanly, exactly as the queued write settles in production.
    waitForCredsSaveQueueWithTimeoutMock
      .mockResolvedValueOnce("timed_out")
      .mockResolvedValue("drained");

    const controller = new WhatsAppConnectionController({
      accountId: "d_one",
      authDir,
      verbose: false,
      keepAlive: true,
      heartbeatSeconds: 30,
      transportTimeoutMs: 60_000,
      messageTimeoutMs: 60_000,
      watchdogCheckMs: 5_000,
      reconnectPolicy: { initialMs: 250, maxMs: 1_000, factor: 2, jitter: 0, maxAttempts: 5 },
    });

    await controller.openConnection({
      connectionId: "owned-conn",
      createListener: async () => createListenerStub() as never,
    });

    // The run ends: shutdown rejects because the credential queue did not drain in time.
    await expect(controller.shutdown()).rejects.toThrow("credential persistence did not drain");

    // A successor run (new controller, same Gateway process) must be able to take the account.
    const acquired = await waitUntil(async () => {
      try {
        const lease = await acquireWhatsAppStandaloneConnectionOwner(authDir);
        await lease.release();
        return true;
      } catch {
        return false;
      }
    });

    expect(acquired).toBe(true);
  });
});
