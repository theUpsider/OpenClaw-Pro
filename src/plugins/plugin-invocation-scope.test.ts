import { AsyncLocalStorage } from "node:async_hooks";
import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { PluginInstanceUnavailableError } from "./plugin-instance-error.js";
import { pluginInvocationContext, wrapCurrentPluginInstance } from "./plugin-instance-scope.js";
import { PluginInstance } from "./plugin-instance.js";
import { PluginInvocationScope, runPluginCleanupScope } from "./plugin-invocation-scope.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";

it("finishes plugin and module disposal after its caller scope closes", async () => {
  const instance = new PluginInstance("closed-caller-cleanup");
  const scope = new PluginInvocationScope(createEmptyPluginRegistry(), [instance]);
  const completed: string[] = [];
  instance.lifecycle.onDispose(() => {
    completed.push("plugin");
  });
  instance.onModuleDispose(() => {
    completed.push("module");
  });
  const result = await scope.run(() => {
    scope.release();
    return instance.dispose();
  });
  expect(result.errors).toEqual([]);
  expect(completed).toEqual(["plugin", "module"]);
});

it("keeps exact retained work callable after its admitting parent closes", async () => {
  const registry = createEmptyPluginRegistry();
  const instance = new PluginInstance("retained-capture");
  const sibling = new PluginInstance("unretained-capture");
  const parent = new PluginInvocationScope(registry, [instance, sibling], { retained: true });
  const capture = parent.run(
    () => new PluginInvocationScope(registry, [instance], { retained: true }),
  );
  const called = vi.fn();
  const callback = capture.wrap(instance.wrap(called));
  const unrelated = sibling.wrap(called);
  try {
    parent.release();
    expect(instance.retainedWorkCount).toBe(1);
    expect(sibling.retainedWorkCount).toBe(0);
    callback();
    expect(called).toHaveBeenCalledOnce();
    expect(() => capture.run(unrelated)).toThrow("Plugin invocation scope is closed");
    capture.release();
    expect(() => callback()).toThrow("Plugin retained-capture consumer is closed");
    expect(instance.retainedWorkCount).toBe(0);
  } finally {
    parent.release();
    capture.release();
    await Promise.all([instance.dispose(), sibling.dispose()]);
  }
});

it.each(["idle", "active"])(
  "bounds %s cross-plugin teardown authority to its host cleanup",
  async (mode) => {
    const first = new PluginInstance("first-cleanup");
    const second = new PluginInstance("second-cleanup");
    const unrelated = new PluginInstance("unrelated-cleanup");
    const called = vi.fn();
    const callback = second.wrap(called);
    const forbidden = unrelated.wrap(called);
    const service = first.wrap({ stop: async () => callback() });
    for (const instance of [first, second, unrelated]) {
      instance.quiesce();
    }
    const delayed = createDeferredCore();
    let late: Promise<void> | undefined;
    await runPluginCleanupScope([service, callback], async () => {
      await service.stop();
      expect(() => forbidden()).toThrow(PluginInstanceUnavailableError);
      const resume = async () => {
        await delayed.promise;
        callback();
      };
      late = mode === "active" ? second.wrap(resume)() : resume();
    });
    const refused = expect(late).rejects.toThrow("Plugin cleanup scope is closed");
    delayed.resolve();
    await refused;
    expect(called).toHaveBeenCalledOnce();
    for (const instance of [first, second, unrelated]) {
      await instance.dispose();
    }
  },
);

it("keeps detached plugin calls callable when their captured frame outlives the turn scope", async () => {
  const instance = new PluginInstance("detached-closed-scope");
  const turn = new PluginInvocationScope(createEmptyPluginRegistry(), [instance]);
  // Production shape: a callable registered during the turn plus a captured frame
  // (AsyncResource / timer continuation) that resumes after the turn's scope closes.
  const registered = turn.run(() => instance.run(() => wrapCurrentPluginInstance(() => "ran")));
  const trailing = turn.run(() => AsyncLocalStorage.snapshot());
  turn.release();
  const plain = () => instance.run(() => "plain-ran");
  try {
    // The closed scope still fences leaked callbacks; boundaries must drop it first.
    expect(() => trailing(plain)).toThrow("Plugin invocation scope is closed");
    expect(() => trailing(registered)).toThrow("Plugin invocation scope is closed");
    // A boundary owner running its fresh plugin calls drops the stale frame; both
    // the plain call and the registered callable then run without reviving custody.
    expect(trailing(() => pluginInvocationContext.exit(plain))).toBe("plain-ran");
    expect(trailing(() => pluginInvocationContext.exit(registered))).toBe("ran");
  } finally {
    turn.release();
    await instance.dispose();
  }
});
