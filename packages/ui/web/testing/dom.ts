import { GlobalRegistrator } from "@happy-dom/global-registrator";

// React reads window when it loads, so the page has to exist before any test
// imports react-dom. Each test file takes it down again in render.tsx.
if (!GlobalRegistrator.isRegistered) {
  GlobalRegistrator.register();
}

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
