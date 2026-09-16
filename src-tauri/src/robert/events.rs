//! Typed catalog for the `robert://event` wire contract (rec 12).
//!
//! The capture engine (macOS Swift sidecar `main.swift`, Windows in-process
//! `robert_win`) emits line-delimited JSON; `robert_start` relays it verbatim
//! as `robert://event`, and the frontend parses it (see `src/lib/events.ts`).
//! This enum is the Rust-side mirror of that contract: it serializes to the
//! EXACT same wire strings (verified by the test below). It is a typing/
//! documentation seam — the emitters are unchanged and nothing new is put on
//! the wire — so it is `allow(dead_code)` until an emitter or the agent loop
//! adopts it.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};

/// One line of the `robert://event` stream. `type` is the discriminant; the
/// opt-in mic stream tags `partial`/`final` with `who: "me"`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum RobertEvent {
    /// Capture-engine lifecycle: `{"type":"status","stage":"ready"}`.
    Status { stage: String },
    /// Live (non-final) transcript: `{"type":"partial","text":...,"who":...}`.
    Partial {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        text: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        who: Option<String>,
    },
    /// Completed turn: `{"type":"final","text":...,"who":...}`.
    Final {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        text: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        who: Option<String>,
    },
    /// Engine error: `{"type":"error","message":...}`.
    Error {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    /// A capturable audio process from `--list`: `{"type":"process","pid":...,"bundle":...}`.
    Process {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pid: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        bundle: Option<String>,
    },
}

/// Progressive token stream for the local brain (event `robert://token`),
/// emitted by `robert_suggest_local_stream`: `{"id":<req>,"text":<full>,"done":true?}`.
/// `text` is the FULL text generated so far.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RobertToken {
    pub id: u64,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub done: Option<bool>,
}

#[cfg(test)]
mod event_wire_tests {
    use super::*;

    #[test]
    fn serializes_to_the_existing_wire_strings() {
        assert_eq!(
            serde_json::to_string(&RobertEvent::Status { stage: "ready".into() }).unwrap(),
            r#"{"type":"status","stage":"ready"}"#
        );
        assert_eq!(
            serde_json::to_string(&RobertEvent::Partial {
                text: Some("hi".into()),
                who: Some("me".into())
            })
            .unwrap(),
            r#"{"type":"partial","text":"hi","who":"me"}"#
        );
        // `who` omitted when absent (system-audio turns carry no who tag)
        assert_eq!(
            serde_json::to_string(&RobertEvent::Final {
                text: Some("done".into()),
                who: None
            })
            .unwrap(),
            r#"{"type":"final","text":"done"}"#
        );
        assert_eq!(
            serde_json::to_string(&RobertEvent::Error { message: Some("boom".into()) }).unwrap(),
            r#"{"type":"error","message":"boom"}"#
        );
        assert_eq!(
            serde_json::to_string(&RobertEvent::Process {
                pid: Some(0),
                bundle: Some("system.audio".into())
            })
            .unwrap(),
            r#"{"type":"process","pid":0,"bundle":"system.audio"}"#
        );
        // deserializes a raw engine line back into the typed shape
        let parsed: RobertEvent =
            serde_json::from_str(r#"{"type":"final","text":"hello","who":"them"}"#).unwrap();
        assert_eq!(
            parsed,
            RobertEvent::Final { text: Some("hello".into()), who: Some("them".into()) }
        );
        // token stream: done omitted, then present
        assert_eq!(
            serde_json::to_string(&RobertToken { id: 7, text: "abc".into(), done: None }).unwrap(),
            r#"{"id":7,"text":"abc"}"#
        );
        assert_eq!(
            serde_json::to_string(&RobertToken { id: 7, text: "abc".into(), done: Some(true) })
                .unwrap(),
            r#"{"id":7,"text":"abc","done":true}"#
        );
    }
}
