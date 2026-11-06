import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const React = require("react");
const { JSDOM } = require("jsdom");
const ts = require("typescript");

test("mounted compliance page presents validation and review state", async (t) => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost:3000"
  });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true, writable: true, value
    });
  }

  const { createRoot } = require("react-dom/client");
  const translate = (text: string) => text;
  const categories = [
    "authority_to_list", "fire_safety", "gas_safety", "electrical_safety",
    "smoke_co_alarms", "public_liability_insurance", "licences_permissions"
  ];
  let mode = "validation";
  let initialStatus = "approved";
  let puts = 0;

  const source = fs.readFileSync(
    "app/host/properties/[id]/compliance/page.tsx", "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true
    }
  }).outputText;
  const module = { exports: {} as any };
  vm.runInNewContext(compiled, {
    module, exports: module.exports,
    require(name: string) {
      if (name === "react" || name === "react/jsx-runtime") return require(name);
      if (name === "@/components/HostNav") return { HostNav: () => null };
      if (name === "@/lib/i18n/useHostI18n") {
        return { useHostI18n: () => ({ ht: translate, hStatus: translate }) };
      }
      throw new Error("Unexpected import: " + name);
    },
    fetch: async (_url: string, options: any) => {
      assert.equal(options.credentials, "include");
      if (options.method !== "PUT") {
        return { ok: true, json: async () => ({ compliance: {
          property: {
            name: "Fictional test property",
            compliance_status: initialStatus,
            compliance_review_note: "Earlier fictional review"
          },
          items: categories.map(category => ({
            category, applicability: "required",
            owner_declared_compliant: true,
            evidence_url: "https://example.test/evidence",
            evidence_reference: "Fictional test evidence",
            review_status: "approved"
          }))
        }}) };
      }
      puts++;
      const request = JSON.parse(options.body);
      assert.equal(request.submit, false);
      assert.equal(request.items.length, 7);
      if (mode === "network") throw new Error("Mock network failure");
      if (mode === "json") {
        return { ok: true, json: async () => { throw new Error("Unreadable response"); } };
      }
      if (mode === "success") {
        return { ok: true, json: async () => ({ status: "in_progress" }) };
      }
      return { ok: false, json: async () => ({ error: {
        code: "INVALID_INPUT",
        message: "items.3.evidenceUrl: electrical safety: Invalid link",
        issues: [{
          path: ["items", 3, "evidenceUrl"],
          message: "Invalid HTTPS link"
        }]
      }}) };
    }
  });
  const Page = module.exports.default;

  async function mounted(run: (container: any) => Promise<void>) {
    puts = 0;
    const container = dom.window.document.createElement("div");
    dom.window.document.body.appendChild(container);
    const root = createRoot(container);
    const params = Promise.resolve({ id: "fixture-property" });
    try {
      await React.act(async () => {
        root.render(React.createElement(Page, { params }));
      });
      assert.match(container.textContent, /Fictional test property/);
      await run(container);
    } finally {
      await React.act(async () => root.unmount());
      container.remove();
    }
  }
  async function save(container: any) {
    const button = Array.from(container.querySelectorAll("button"))
      .find((button: any) => button.textContent === "Save draft") as any;
    assert.ok(button);
    await React.act(async () => button.click());
    assert.equal(puts, 1);
    assert.equal(button.disabled, false);
  }

  try {
    await t.test("validation highlights the evidence field without raw API paths", async () => {
      mode = "validation";
      initialStatus = "approved";
      await mounted(async container => {
        await save(container);
        const invalid = container.querySelectorAll('[aria-invalid="true"]');
        assert.equal(invalid.length, 1);
        const description = invalid[0].getAttribute("aria-describedby");
        assert.equal(description, "evidence-error-electrical_safety");
        assert.match(container.querySelector("#" + description).textContent, /HTTPS/);
        assert.match(container.querySelector('[role="alert"]').textContent, /highlighted evidence links/);
        assert.doesNotMatch(container.textContent, /items\.3\.evidenceUrl/);
        assert.doesNotMatch(container.textContent, /Previous HOST review/);
        assert.match(container.textContent, /Status: approved/);
      });
    });

    await t.test("valid save labels earlier review and clears item approval labels", async () => {
      mode = "success";
      initialStatus = "approved";
      await mounted(async container => {
        await save(container);
        assert.match(container.textContent, /Status: in_progress/);
        assert.match(container.textContent, /Previous HOST review/);
        assert.match(container.textContent, /current record has not been approved/);
        assert.doesNotMatch(container.textContent, /HOST review: approved/);
        assert.equal(container.querySelector('[role="status"]').textContent, "Compliance draft saved.");
      });
    });

    await t.test("loaded submitted record labels its previous review", async () => {
      initialStatus = "submitted";
      await mounted(async container => {
        assert.match(container.textContent, /Previous HOST review/);
        assert.match(container.textContent, /Earlier fictional review/);
        assert.match(container.textContent, /current record has not been approved/);
        assert.equal(puts, 0);
      });
    });

    for (const failure of ["network", "json"]) {
      await t.test(`${failure} failure releases buttons and advises checking status`, async () => {
        mode = failure;
        initialStatus = "approved";
        await mounted(async container => {
          await save(container);
          assert.match(container.querySelector('[role="alert"]').textContent,
            /Reload the page to check the current status/);
          assert.match(container.textContent, /Status: approved/);
          assert.ok(Array.from(container.querySelectorAll("button"))
            .every((button: any) => !button.disabled));
        });
      });
    }
  } finally {
    dom.window.close();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as any)[name];
    }
  }
});
