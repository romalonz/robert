// Robert Core — the provider-agnostic platform interfaces (recs 3, 4, 24).
//
// These seams wrap Robert's EXISTING functionality behind stable interfaces so
// skills and the agent loop can consume a platform rather than reaching for
// invoke directly. Nothing here changes runtime behavior; the live suggest()
// path does not yet route through them. The Brain seam lives in Rust
// (robert/providers.rs::BrainProvider); the event catalog is lib/events.ts.

export * from "./tools";
export * from "./memory";
export * from "./context";
