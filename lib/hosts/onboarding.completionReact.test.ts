import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const React = require("react");
const { createRoot } = require("react-dom/client");
const { JSDOM } = require("jsdom");
const ts = require("typescript");

test("completion page mounted React lifecycle", async (t) => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost:3000"
  });
  const globals = globalThis as any;
  const replacements: Record<string, any> = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true
  };
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries(replacements)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true, writable: true, value
    });
  }

  const SessionContext = React.createContext(null);
  let updates = 0;
  let requests = 0;
  let failRefresh = false;
  let changeAuthentication: (value: string) => void = () => {
    throw new Error("Session fixture not mounted");
  };

  const source = fs.readFileSync(
    "app/host/onboarding/complete/page.tsx", "utf8"
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true
    }
  }).outputText;
  const pageModule = { exports: {} as any };
  vm.runInNewContext(compiled, {
    module: pageModule,
    exports: pageModule.exports,
    require(name: string) {
      if (name === "react" || name === "react/jsx-runtime") return require(name);
      if (name === "next-auth/react") {
        return { useSession: () => React.useContext(SessionContext) };
      }
      if (name === "@/lib/i18n/useHostI18n") {
        return { useHostI18n: () => ({ ht: (text: string) => text }) };
      }
      throw new Error("Unexpected component import: " + name);
    },
    fetch: async (url: string, options: any) => {
      assert.equal(url, "/api/hosts/onboarding/status");
      assert.equal(options.credentials, "include");
      requests++;
      return { json: async () => ({ success: true, status: "not_connected" }) };
    }
  }, { filename: "onboarding-complete.component.cjs" });
  const Page = pageModule.exports.default;

  function SessionFixture({ initial }: { initial: string }) {
    const [status, setStatus] = React.useState(initial);
    const [revision, setRevision] = React.useState(0);
    changeAuthentication = setStatus;

    // Intentionally recreate update on every render, as the real provider can.
    const update = async (...args: any[]) => {
      assert.equal(args.length, 0);
      updates++;
      setStatus("loading");
      await Promise.resolve();
      setRevision((value: number) => value + 1);
      setStatus("authenticated");
      if (failRefresh) throw new Error("Mock session refresh rejected");
      return { user: { id: "fixture-user", roles: ["guest", "host"] } };
    };
    return React.createElement(SessionContext.Provider, {
      value: { status, update, revision }
    }, React.createElement(Page));
  }

  async function mounted(initial: string, run: (container: any) => Promise<void>) {
    updates = 0;
    requests = 0;
    const container = dom.window.document.createElement("div");
    dom.window.document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await React.act(async () => {
        root.render(React.createElement(
          React.StrictMode, null,
          React.createElement(SessionFixture, { initial })
        ));
      });
      await run(container);
    } finally {
      await React.act(async () => root.unmount());
      container.remove();
    }
  }

  try {
    await t.test("StrictMode and session loading transitions settle once", async () => {
      failRefresh = false;
      await mounted("authenticated", async (container) => {
        assert.equal(updates, 1);
        assert.equal(requests, 1);
        assert.match(container.textContent, /A few more details are needed/);
        for (let i = 0; i < 5; i++) {
          await React.act(async () => changeAuthentication("loading"));
          await React.act(async () => changeAuthentication("authenticated"));
        }
        assert.equal(updates, 1);
        assert.equal(requests, 1);
      });
    });

    await t.test("signed-out mount waits until authentication", async () => {
      failRefresh = false;
      await mounted("unauthenticated", async (container) => {
        assert.equal(updates, 0);
        assert.equal(requests, 0);
        assert.match(container.textContent, /Please sign in/);
        await React.act(async () => changeAuthentication("authenticated"));
        assert.equal(updates, 1);
        assert.equal(requests, 1);
        assert.match(container.textContent, /A few more details are needed/);
      });
    });

    await t.test("refresh rejection renders error without retrying", async () => {
      failRefresh = true;
      await mounted("authenticated", async (container) => {
        assert.equal(updates, 1);
        assert.equal(requests, 0);
        assert.match(container.textContent, /Something went wrong/);
        await React.act(async () => changeAuthentication("loading"));
        await React.act(async () => changeAuthentication("authenticated"));
        assert.equal(updates, 1);
        assert.equal(requests, 0);
      });
    });
  } finally {
    dom.window.close();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globals[name];
    }
  }
});
