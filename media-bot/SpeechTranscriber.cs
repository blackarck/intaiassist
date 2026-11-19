using System.Collections.Concurrent;
using System.Diagnostics;
using Microsoft.CognitiveServices.Speech;
using Microsoft.CognitiveServices.Speech.Audio;

namespace MediaBot;

/// <summary>
/// One Azure Speech recognizer per speaker. Teams gives us UNMIXED audio tagged with the speaker's source id,
/// so there is no diarization problem: each speaker gets their own push stream (16 kHz, 16-bit, mono PCM).
///
/// Teams only delivers buffers while someone is speaking, so a recognizer would never see the trailing silence
/// it needs to finalize an utterance. A small timer injects a short run of silence after a speaker stops.
/// </summary>
public sealed class SpeechTranscriber : IDisposable
{
    private const int SampleRate = 16000;
    private const int SilenceFlushAfterMs = 700;
    private static readonly byte[] Silence = new byte[SampleRate * 2]; // 1 s of zeros

    private sealed class Channel
    {
        public required PushAudioInputStream Stream { get; init; }
        public required SpeechRecognizer Recognizer { get; init; }
        public required long StartMs { get; init; }
        public long LastAudioMs;
        public bool SilenceSent;
    }

    private readonly SpeechConfig _config;
    private readonly string _interviewId;
    private readonly ParticipantDirectory _directory;
    private readonly IEventSink _sink;
    private readonly ILogger _log;
    private readonly Stopwatch _clock = Stopwatch.StartNew();
    private readonly ConcurrentDictionary<uint, Channel> _channels = new();
    private readonly object _createLock = new();
    private readonly Timer _flushTimer;
    private volatile bool _disposed;

    public SpeechTranscriber(SpeechOptions opts, string interviewId, ParticipantDirectory directory, IEventSink sink, ILogger log)
    {
        if (string.IsNullOrWhiteSpace(opts.Key) || string.IsNullOrWhiteSpace(opts.Region))
            throw new InvalidOperationException("Speech:Key and Speech:Region are required for live transcription.");

        _config = SpeechConfig.FromSubscription(opts.Key, opts.Region);
        _config.SpeechRecognitionLanguage = opts.Language;
        _interviewId = interviewId;
        _directory = directory;
        _sink = sink;
        _log = log;
        _flushTimer = new Timer(_ => FlushSilence(), null, 250, 250);
    }

    /// <summary>Called from the media thread. Must be fast and must not retain <paramref name="pcm"/>.</summary>
    public void Push(uint speakerMsi, byte[] pcm)
    {
        if (_disposed) return;
        var ch = _channels.TryGetValue(speakerMsi, out var existing) ? existing : CreateChannel(speakerMsi);
        ch.Stream.Write(pcm);
        ch.LastAudioMs = _clock.ElapsedMilliseconds;
        ch.SilenceSent = false;
    }

    private Channel CreateChannel(uint msi)
    {
        lock (_createLock)
        {
            if (_channels.TryGetValue(msi, out var existing)) return existing;

            var stream = AudioInputStream.CreatePushStream(AudioStreamFormat.GetWaveFormatPCM(SampleRate, 16, 1));
            var recognizer = new SpeechRecognizer(_config, AudioConfig.FromStreamInput(stream));
            var ch = new Channel { Stream = stream, Recognizer = recognizer, StartMs = _clock.ElapsedMilliseconds };

            recognizer.Recognizing += (_, e) => Emit(msi, ch, e.Result, isFinal: false);
            recognizer.Recognized += (_, e) =>
            {
                if (e.Result.Reason == ResultReason.RecognizedSpeech) Emit(msi, ch, e.Result, isFinal: true);
            };
            recognizer.Canceled += (_, e) =>
            {
                if (e.Reason == CancellationReason.Error)
                    _log.LogError("speech canceled for msi {Msi}: {Code} {Detail}", msi, e.ErrorCode, e.ErrorDetails);
            };

            recognizer.StartContinuousRecognitionAsync().GetAwaiter().GetResult();
            _channels[msi] = ch;
            return ch;
        }
    }

    private void Emit(uint msi, Channel ch, SpeechRecognitionResult result, bool isFinal)
    {
        if (string.IsNullOrWhiteSpace(result.Text)) return;
        var (speakerId, name, role) = _directory.Resolve(msi);
        var startMs = ch.StartMs + result.OffsetInTicks / 10_000;
        var seg = new TranscriptSegment(_interviewId, speakerId, name, role, result.Text, isFinal, startMs);
        _ = _sink.SegmentAsync(seg).ContinueWith(
            t => _log.LogError(t.Exception, "failed to deliver segment"),
            TaskContinuationOptions.OnlyOnFaulted);
    }

    private void FlushSilence()
    {
        if (_disposed) return;
        var now = _clock.ElapsedMilliseconds;
        foreach (var ch in _channels.Values)
        {
            if (!ch.SilenceSent && now - ch.LastAudioMs > SilenceFlushAfterMs)
            {
                ch.SilenceSent = true;
                try { ch.Stream.Write(Silence); } catch { /* stream closed during shutdown */ }
            }
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _flushTimer.Dispose();
        foreach (var ch in _channels.Values)
        {
            try
            {
                ch.Stream.Write(Silence); // let the last utterance finalize
                ch.Stream.Close();
                ch.Recognizer.StopContinuousRecognitionAsync().GetAwaiter().GetResult();
                ch.Recognizer.Dispose();
            }
            catch (Exception e)
            {
                _log.LogWarning(e, "error stopping recognizer");
            }
        }
        _channels.Clear();
    }
}
