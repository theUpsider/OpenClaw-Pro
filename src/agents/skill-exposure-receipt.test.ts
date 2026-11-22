import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { serializeModelRequestBody } from "../../packages/ai/src/transports/model-request-body.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import { finalizeAgentToolAvailability } from "./agent-tool-availability.js";
import { createReadTool } from "./sessions/tools/read.js";
import { createSkillExposureReceiptCollector } from "./skill-exposure-receipt.js";
import type { AnyAgentTool } from "./tools/common.js";
import { createInstalledSkillTools } from "./tools/installed-skill-tools.js";

// Independent collector contracts; these serializations are not external model executions.
const content = "---\nname: guide\n---\nUse the entire guide.\n";

function tools(runId: string, reader?: () => Promise<string>) {
  return finalizeAgentToolAvailability(
    createInstalledSkillTools(
      [
        {
          name: "guide",
          description: "Guide",
          location: "skill://guide",
          source: { filePath: "/synthetic/SKILL.md", ...(reader ? {} : { readContent: content }) },
          ...(reader ? { reader } : {}),
        },
      ],
      runId,
    ),
  );
}

function serialize(
  collector: ReturnType<typeof createSkillExposureReceiptCollector>,
  runId: string,
  result: Awaited<ReturnType<AnyAgentTool["execute"]>>,
  callId = "read-guide",
) {
  const text = result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  const encoded = serializeModelRequestBody({
    messages: [{ role: "tool", tool_call_id: callId, content: text }],
  });
  collector.beginRequest(runId, { api: "openai-completions" })?.(encoded.body);
}

it("does not promote metadata indexing or ordinary file reads into instruction exposure", async () => {
  await withTempDir("skill-exposure-file-", async (cwd) => {
    await writeFile(path.join(cwd, "SKILL.md"), content);
    const collector = createSkillExposureReceiptCollector("run");
    const [search] = tools("run");
    const found = await expectDefined(search, "search tool").execute("search", { query: "guide" });
    collector.onAgentToolResult({ toolName: "skills_search", result: found, isError: false });
    const file = await createReadTool(cwd).execute("read-guide", { path: "SKILL.md" });
    collector.onAgentToolResult({ toolName: "read", result: file, isError: false });
    serialize(collector, "run", file);
    expect(collector.finish()).toMatchObject({
      loadedSkills: [],
      skillExposure: { status: "available" },
    });
  });
});

it.each([
  "unbranded details",
  "failed result",
  "wrong read run",
  "wrong request run",
  "wrong call",
])("requires native exact-run read and request provenance: %s", async (mode) => {
  const collector = createSkillExposureReceiptCollector("run");
  const read = expectDefined(tools(mode === "wrong read run" ? "other" : "run")[1], "reader");
  const native = await read.execute("read-guide", { name: "guide" });
  const result =
    mode === "unbranded details" ? { ...native, details: structuredClone(native.details) } : native;
  collector.onAgentToolResult({
    toolName: "skills_read",
    result,
    isError: mode === "failed result",
  });
  serialize(
    collector,
    mode === "wrong request run" ? "other" : "run",
    result,
    mode === "wrong call" ? "other-call" : "read-guide",
  );
  expect(collector.finish().loadedSkills).toEqual([]);
});

it("separates concurrent reads and accepts delayed tool observations", async () => {
  const a = createSkillExposureReceiptCollector("a");
  const b = createSkillExposureReceiptCollector("b");
  const pending = createDeferred<string>();
  const readA = expectDefined(tools("a", () => pending.promise)[1], "reader a");
  const readB = expectDefined(tools("b")[1], "reader b");
  const readingA = readA.execute("read-guide", { name: "guide" });
  const resultB = await readB.execute("read-guide", { name: "guide" });
  pending.resolve("Different instructions for A.");
  const resultA = await readingA;
  // Final serialization can precede the queued subscriber's completion callback.
  serialize(a, "a", resultA);
  serialize(b, "b", resultB);
  a.onAgentToolResult({ toolName: "skills_read", result: resultB, isError: false });
  b.onAgentToolResult({ toolName: "skills_read", result: resultA, isError: false });
  a.onAgentToolResult({ toolName: "skills_read", result: resultA, isError: false });
  b.onAgentToolResult({ toolName: "skills_read", result: resultB, isError: false });
  const receiptA = a.finish();
  const receiptB = b.finish();
  expect(receiptA.loadedSkills).toHaveLength(1);
  expect(receiptB.loadedSkills).toHaveLength(1);
  expect(receiptA.loadedSkills[0]?.runId).toBe("a");
  expect(receiptB.loadedSkills[0]?.runId).toBe("b");
  expect(receiptA.loadedSkills[0]?.sha256).not.toBe(receiptB.loadedSkills[0]?.sha256);
  serialize(a, "a", resultB);
  expect(a.finish()).toEqual(receiptA);
});

it.each([
  "unsupported",
  "onPayload only",
  "request count exceeded",
  "request bytes exceeded",
  "tool texts exceeded",
  "read count exceeded",
  "unsettled cleanup",
])("reports explicit unavailable evidence for %s", async (mode) => {
  const collector = createSkillExposureReceiptCollector("run");
  const read = expectDefined(tools("run")[1], "reader");
  const result = await read.execute("read-guide", { name: "guide" });
  collector.onAgentToolResult({ toolName: "skills_read", result, isError: false });
  if (mode === "unsupported") {
    collector.beginRequest("run", { api: "anthropic-messages" });
  } else if (mode === "onPayload only") {
    collector.beginRequest("run", { api: "openai-completions" });
  } else if (mode === "request count exceeded") {
    for (let index = 0; index < 65; index++) {
      serialize(collector, "run", result);
    }
  } else if (mode === "request bytes exceeded") {
    collector.beginRequest("run", { api: "openai-completions" })?.(
      new Uint8Array(8 * 1024 * 1024 + 1),
    );
  } else if (mode === "tool texts exceeded") {
    const encoded = serializeModelRequestBody({
      messages: Array.from({ length: 257 }, (_, index) => ({
        role: "tool",
        tool_call_id: `call-${index}`,
        content: "output",
      })),
    });
    collector.beginRequest("run", { api: "openai-completions" })?.(encoded.body);
  } else if (mode === "read count exceeded") {
    for (let index = 0; index < 65; index++) {
      collector.onAgentToolResult({
        toolName: "skills_read",
        result: await read.execute(`call-${index}`, { name: "guide" }),
        isError: false,
      });
    }
  } else {
    serialize(collector, "run", result);
  }
  expect(collector.finish(mode !== "unsettled cleanup")).toMatchObject({
    loadedSkills: [],
    skillExposure: {
      status: "unavailable",
      reason:
        mode === "unsupported"
          ? "unsupported_provider"
          : mode.endsWith("exceeded")
            ? "limit_exceeded"
            : "incomplete_collection",
    },
  });
});

it("rejects ambiguous reused call IDs", async () => {
  const collector = createSkillExposureReceiptCollector("run");
  const read = expectDefined(tools("run")[1], "reader");
  const first = await read.execute("read-guide", { name: "guide" });
  serialize(collector, "run", first);
  collector.onAgentToolResult({ toolName: "skills_read", result: first, isError: false });
  const secondRead = expectDefined(tools("run", async () => "Different body")[1], "second reader");
  collector.onAgentToolResult({
    toolName: "skills_read",
    result: await secondRead.execute("read-guide", { name: "guide" }),
    isError: false,
  });
  expect(collector.finish()).toMatchObject({
    loadedSkills: [],
    skillExposure: { status: "unavailable", reason: "incomplete_collection" },
  });
});

it("rejects oversized whole reads before creating exposure evidence", async () => {
  const oversized = createSkillExposureReceiptCollector("large");
  const largeRead = expectDefined(
    createInstalledSkillTools(
      [
        {
          name: "guide",
          description: "Guide",
          location: "skill://guide",
          promptListed: true,
          source: { filePath: "/synthetic/SKILL.md", readContent: "x".repeat(256 * 1024 + 1) },
        },
      ],
      "large",
    )[1],
    "large reader",
  );
  const largeResult = await largeRead.execute("large-read", { name: "guide" });
  oversized.onAgentToolResult({ toolName: "skills_read", result: largeResult, isError: false });
  expect(oversized.finish()).toMatchObject({
    loadedSkills: [],
    skillExposure: { status: "unavailable", reason: "limit_exceeded" },
  });
});
