use std::path::PathBuf;
use std::sync::Arc;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use parking_lot::Mutex;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

pub struct DictationService {
    session: Mutex<Option<DictationSession>>,
}

struct DictationSession {
    samples: Arc<Mutex<Vec<f32>>>,
    sample_rate: u32,
    channels: u16,
    _stream: cpal::Stream,
}

impl Default for DictationService {
    fn default() -> Self {
        Self::new()
    }
}

impl DictationService {
    pub fn new() -> Self {
        Self {
            session: Mutex::new(None),
        }
    }

    pub fn start(&self) -> Result<(), String> {
        let mut session = self.session.lock();
        if session.is_some() {
            return Ok(());
        }

        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .ok_or_else(|| "No microphone is available.".to_string())?;
        let config = device.default_input_config().map_err(|error| error.to_string())?;
        let sample_rate = config.sample_rate();
        let channels = config.channels();
        let stream_config = config.config();
        let samples = Arc::new(Mutex::new(Vec::new()));
        let writer = samples.clone();
        let err_fn = |error| tracing::warn!(error = %error, "dictation input stream error");

        let stream = match config.sample_format() {
            cpal::SampleFormat::F32 => device.build_input_stream(
                stream_config,
                move |data: &[f32], _| writer.lock().extend_from_slice(data),
                err_fn,
                None,
            ),
            cpal::SampleFormat::I16 => device.build_input_stream(
                stream_config,
                move |data: &[i16], _| {
                    writer
                        .lock()
                        .extend(data.iter().map(|sample| *sample as f32 / i16::MAX as f32));
                },
                err_fn,
                None,
            ),
            cpal::SampleFormat::U16 => device.build_input_stream(
                stream_config,
                move |data: &[u16], _| {
                    writer.lock().extend(
                        data.iter()
                            .map(|sample| (*sample as f32 / u16::MAX as f32) * 2.0 - 1.0),
                    );
                },
                err_fn,
                None,
            ),
            other => return Err(format!("Unsupported microphone sample format: {other:?}")),
        }
        .map_err(|error| error.to_string())?;

        stream.play().map_err(|error| error.to_string())?;
        *session = Some(DictationSession {
            samples,
            sample_rate,
            channels,
            _stream: stream,
        });
        Ok(())
    }

    pub fn stop(&self, bundled_model: Option<PathBuf>) -> Result<String, String> {
        let session = self
            .session
            .lock()
            .take()
            .ok_or_else(|| "Dictation is not running.".to_string())?;
        drop(session._stream);

        let captured = session.samples.lock().clone();
        if captured.is_empty() {
            return Err("No speech was detected.".to_string());
        }

        let mono = mono_samples(&captured, session.channels);
        let audio = resample_linear(&mono, session.sample_rate, 16_000);
        transcribe(&audio, bundled_model)
    }

    pub fn cancel(&self) {
        self.session.lock().take();
    }
}

fn mono_samples(samples: &[f32], channels: u16) -> Vec<f32> {
    if channels <= 1 {
        return samples.to_vec();
    }
    samples
        .chunks(channels as usize)
        .map(|frame| frame.iter().sum::<f32>() / frame.len() as f32)
        .collect()
}

fn resample_linear(samples: &[f32], from_rate: u32, to_rate: u32) -> Vec<f32> {
    if from_rate == to_rate || samples.is_empty() {
        return samples.to_vec();
    }
    let output_len = (samples.len() as u64 * to_rate as u64 / from_rate as u64).max(1) as usize;
    let ratio = from_rate as f64 / to_rate as f64;
    (0..output_len)
        .map(|index| {
            let source = index as f64 * ratio;
            let left = source.floor() as usize;
            let right = (left + 1).min(samples.len() - 1);
            let blend = (source - left as f64) as f32;
            samples[left] * (1.0 - blend) + samples[right] * blend
        })
        .collect()
}

fn transcribe(audio: &[f32], bundled_model: Option<PathBuf>) -> Result<String, String> {
    let model_path = model_path(bundled_model)?;
    let context = WhisperContext::new_with_params(
        model_path
            .to_str()
            .ok_or_else(|| "Whisper model path is not valid UTF-8.".to_string())?,
        WhisperContextParameters::default(),
    )
    .map_err(|error| error.to_string())?;
    let mut state = context.create_state().map_err(|error| error.to_string())?;
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(Some("en"));
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    state.full(params, audio).map_err(|error| error.to_string())?;

    let mut text = String::new();
    for index in 0..state.full_n_segments() {
        if let Some(segment) = state.get_segment(index) {
            text.push_str(&segment.to_str_lossy().map_err(|error| error.to_string())?);
        }
    }
    Ok(text.trim().to_string())
}

fn model_path(bundled_model: Option<PathBuf>) -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("TERMINAI_WHISPER_MODEL") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Ok(path);
        }
    }

    if let Some(path) = bundled_model {
        if path.is_file() {
            return Ok(path);
        }
    }

    let path = dirs::data_dir()
        .ok_or_else(|| "Could not find app data directory.".to_string())?
        .join("ccie-terminal")
        .join("models")
        .join("ggml-base.en.bin");
    if path.is_file() {
        return Ok(path);
    }

    Err(format!(
        "Whisper model not found. Reinstall TerminAI or set TERMINAI_WHISPER_MODEL. Checked {}.",
        path.display()
    ))
}
