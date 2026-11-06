
import { mock } from "node:test";
mock.module(new URL("../notifications/emailProvider.ts", import.meta.url).href, {
  namedExports: { sendEmail: async () => {} },
});
