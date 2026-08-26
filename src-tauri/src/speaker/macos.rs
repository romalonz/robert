// Pluely macOS speaker input and stream.
// ROBERT FORK NOTE: the original used `cidre` for system-audio capture, whose
// build script requires full Xcode. To build on Command Line Tools, this is
// stubbed out. Robert provides its own Core Audio process-tap capture (verified
// in robert/spikes/capture_test.swift), so the built-in path is intentionally
// disabled here. Restore the original (and install full Xcode) to re-enable it.
use super::AudioDevice;
use anyhow::Result;
use futures_util::Stream;
use std::pin::Pin;
use std::task::{Context, Poll};

pub fn get_input_devices() -> Result<Vec<AudioDevice>> {
    Ok(vec![])
}

pub fn get_output_devices() -> Result<Vec<AudioDevice>> {
    Ok(vec![])
}

pub struct SpeakerInput;

impl SpeakerInput {
    pub fn new(_device_id: Option<String>) -> Result<Self> {
        Err(anyhow::anyhow!(
            "Built-in system-audio capture is disabled in this Command Line Tools build (cidre needs full Xcode). Robert uses its own Core Audio capture."
        ))
    }

    pub fn stream(self) -> SpeakerStream {
        SpeakerStream
    }
}

pub struct SpeakerStream;

impl SpeakerStream {
    pub fn sample_rate(&self) -> u32 {
        16000
    }
}

impl Stream for SpeakerStream {
    type Item = f32;

    fn poll_next(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        Poll::Ready(None)
    }
}
