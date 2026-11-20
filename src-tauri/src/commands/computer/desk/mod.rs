//! Computer use without Tauri: the rules, the math and the platform layer.
//!
//! Nothing in this module tree knows about the app around it, so the whole
//! of it compiles and tests on its own, for every target.

pub mod adapter;
pub mod blocklist;
pub mod capture;
pub mod engine;
pub mod geometry;
pub mod injection;
pub mod keys;
pub mod platform;
pub mod sensitive;
pub mod takeover;
pub mod tree;
pub mod types;
