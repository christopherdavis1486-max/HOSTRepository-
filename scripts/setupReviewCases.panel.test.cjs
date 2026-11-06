const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const { JSDOM } = require("jsdom");

const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost:3001" });
global.window = dom.window;
global.document = dom.window.document;
global.HTMLElement = dom.window.HTMLElement;
global.IS_REACT_ACT_ENVIRONMENT = true;
const React = require("react");
const { createRoot } = require("react-dom/client");
const filename = "components/SetupReviewCases.tsx";
const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;

const bookingId = "11111111-1111-4111-8111-111111111111";
const sourceAuditId = "22222222-2222-4222-8222-222222222222";
const record = {
  sourceAuditId,
  recordedAt: "2026-11-02T12:00:00.000Z",
  phase: "payment_method_save",
  trackingStatus: "unclaimed",
  version: 0,
  case: null,
};
const response = (status, data) => ({
  status, ok: status >= 200 && status < 300,
  json: async () => data,
});
const loaded = (records = [record]) =>
  response(200, { success: true, reviews: { records, hasMore: false } });

test("setup review panel behaviour", async t => {
  async function mount(respond, run) {
    const calls = [];
    const mod = { exports: {} };
    vm.runInNewContext(code, {
      module: mod, exports: mod.exports,
      require(name) {
        if (name === "react" || name === "react/jsx-runtime") return require(name);
        throw new Error("Unexpected import: " + name);
      },
      fetch: async (url, options) => {
        calls.push({ url, options });
        assert.equal(options.credentials, "include");
        return respond(calls.length, url, options);
      },
    }, { filename });
    const container = document.getElementById("root");
    const root = createRoot(container);
    async function clickLoad() {
      await React.act(async () => {
        [...container.querySelectorAll("button")]
          .find(button => button.textContent.includes("reload reviews")).click();
      });
    }
    async function fillNote() {
      await React.act(async () => {
        const field = container.querySelector("textarea");
        Object.getOwnPropertyDescriptor(
          dom.window.HTMLTextAreaElement.prototype, "value"
        ).set.call(field, "Investigation evidence checked.");
        field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
      assert.equal(container.querySelector('button[type="submit"]').disabled, false);
    }
    async function submit() {
      await React.act(async () => {
        container.querySelector("form").dispatchEvent(
          new dom.window.Event("submit", { bubbles: true, cancelable: true })
        );
      });
    }
    try {
      await React.act(async () => {
        root.render(React.createElement(mod.exports.SetupReviewCases, { bookingId }));
      });
      assert.equal(calls.length, 0, "Loading should be explicit");
      await run({ container, calls, clickLoad, fillNote, submit });
    } finally { await React.act(async () => root.unmount()); }
  }

  await t.test("loads unclaimed evidence with required note and no raw provider fields", async () => {
    await mount(async () => loaded(), async ({ container, calls, clickLoad }) => {
      await clickLoad();
      assert.ok(calls[0].url.endsWith(encodeURIComponent(bookingId)));
      assert.ok(container.textContent.includes("unclaimed"));
      assert.equal(container.querySelector('button[type="submit"]').disabled, true);
      assert.equal(container.querySelector("textarea").name, "reviewNote");
    });
  });
  await t.test("empty evidence does not imply payment success", async () => {
    await mount(async () => loaded([]), async ({ container, clickLoad }) => {
      await clickLoad();
      assert.ok(container.textContent.includes("does not establish"));
      assert.equal(container.querySelector("form"), null);
    });
  });
  await t.test("load failure hides server details and offers no mutation form", async () => {
    await mount(async () => response(403, {
      success: false, error: { message: "PRIVATE_DETAIL" },
    }), async ({ container, clickLoad }) => {
      await clickLoad();
      assert.ok(container.querySelector('[role="alert"]'));
      assert.ok(!container.textContent.includes("PRIVATE_DETAIL"));
      assert.equal(container.querySelector("form"), null);
    });
  });
  await t.test("successful mutation sends current version then reloads", async () => {
    await mount(async count => count === 2
      ? response(200, { success: true })
      : loaded(count === 3 ? [{
          ...record, trackingStatus: "in_review", version: 1,
          case: { assignedTo: bookingId },
        }] : [record]),
      async ({ container, calls, clickLoad, fillNote, submit }) => {
        await clickLoad(); await fillNote(); await submit();
        assert.equal(calls.length, 3);
        const body = JSON.parse(calls[1].options.body);
        assert.equal(body.bookingId, bookingId);
        assert.equal(body.sourceAuditId, sourceAuditId);
        assert.equal(body.expectedVersion, 0);
        assert.equal(body.action, "claim");
        assert.ok(!Object.hasOwn(body, "actorUserId"));
        assert.ok(container.textContent.includes("Version: 1"));
        assert.ok(container.textContent.includes("Review update saved."));
      });
  });
  await t.test("version conflict reloads before allowing another update", async () => {
    await mount(async count => count === 2
      ? response(409, { success: false })
      : loaded(), async ({ container, calls, clickLoad, fillNote, submit }) => {
        await clickLoad(); await fillNote(); await submit();
        assert.equal(calls.length, 3);
        assert.ok(container.textContent.includes("review changed"));
      });
  });
  await t.test("lost mutation response reloads without automatic replay", async () => {
    await mount(async count => {
      if (count === 2) throw new Error("PRIVATE_DETAIL");
      return loaded();
    }, async ({ container, calls, clickLoad, fillNote, submit }) => {
      await clickLoad(); await fillNote(); await submit();
      assert.equal(calls.filter(call => call.options.method === "PATCH").length, 1);
      assert.equal(calls.length, 3);
      assert.ok(container.textContent.includes("could not be confirmed"));
      assert.ok(!container.textContent.includes("PRIVATE_DETAIL"));
    });
  });
  await t.test("failed refresh after save removes stale mutation forms", async () => {
    await mount(async count => {
      if (count === 2) return response(200, { success: true });
      if (count === 3) throw new Error("unavailable");
      return loaded();
    }, async ({ container, clickLoad, fillNote, submit }) => {
      await clickLoad(); await fillNote(); await submit();
      assert.equal(container.querySelector("form"), null);
      assert.ok(container.querySelector('[role="alert"]').textContent
        .includes("Reload reviews before another update"));
    });
  });
});
test.after(() => dom.window.close());
