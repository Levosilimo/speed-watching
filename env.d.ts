// E2E-build gate (SEC-2): statically replaced by wxt.config.ts's vite define
// — `false` in production builds (dead-code-eliminated), `true` under
// `wxt build --mode e2e`. Not `import.meta.env.*`: vite reserves that
// namespace for env vars and drops user defines on it.
declare const __E2E__: boolean;
