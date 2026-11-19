using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Graph;
using Microsoft.Graph.Models;
using Microsoft.Graph.Communications.Calls;
using Microsoft.Graph.Communications.Calls.Media;
using Microsoft.Graph.Communications.Client;
using Microsoft.Graph.Communications.Common.Telemetry;
using Microsoft.Graph.Communications.Resources;
using Microsoft.Skype.Bots.Media;
using LogLevel = Microsoft.Extensions.Logging.LogLevel;

namespace MediaBot;

/// <summary>Receives Graph call-state webhooks (POST /callback) and hands them to the SDK.</summary>
public interface IGraphCallbackProcessor
{
    Task<HttpResponseMessage> ProcessNotificationAsync(HttpRequestMessage request);
}

/// <summary>
/// Real Teams bot (Option A in doc/bot-join-research.md): joins a meeting by link as an app-hosted media bot,
/// receives UNMIXED per-speaker audio, tells Teams it is recording, and streams per-speaker speech-to-text
/// back to the backend.
///
/// Runtime requirements (Windows only): Windows Server, public IP + FQDN + TLS cert in LocalMachine\My,
/// media port open, Entra multi-tenant app with Calls.* permissions. See doc/spike-runbook.md.
///
/// Verify in the spike (each is an explicit risk in the research doc):
///   - join by link into a meeting in ANOTHER tenant (RSC vs tenant-wide consent)
///   - updateRecordingStatus succeeds for a link-joined (non-policy) bot, because we do not
///     process audio until it does
///   - lobby behaviour: which call state we see while waiting, and what ResultInfo says on denial
/// </summary>
public sealed class GraphMeetingBot : IMeetingBot, IGraphCallbackProcessor, IDisposable
{
    private readonly GraphBotOptions _opts;
    private readonly SpeechOptions _speech;
    private readonly IEventSink _sink;
    private readonly ILoggerFactory _loggerFactory;
    private readonly ILogger<GraphMeetingBot> _log;
    private readonly IGraphLogger _graphLogger;
    private readonly ICommunicationsClient _client;
    private readonly ConcurrentDictionary<string, CallSession> _sessions = new();

    public GraphMeetingBot(
        GraphBotOptions opts,
        SpeechOptions speech,
        GraphAuthProvider auth,
        IEventSink sink,
        ILoggerFactory loggerFactory)
    {
        _opts = opts;
        _speech = speech;
        _sink = sink;
        _loggerFactory = loggerFactory;
        _log = loggerFactory.CreateLogger<GraphMeetingBot>();

        Validate(opts);

        _graphLogger = new GraphLogger(nameof(GraphMeetingBot));
        _graphLogger.Subscribe(new GraphLogObserver(loggerFactory.CreateLogger("GraphSdk")));

        var builder = new CommunicationsClientBuilder(nameof(GraphMeetingBot), opts.AppId, _graphLogger);
        builder.SetAuthenticationProvider(auth);
        builder.SetNotificationUrl(new Uri(opts.NotificationUrl));
        builder.SetServiceBaseUrl(new Uri(opts.GraphBaseUrl));
        builder.SetMediaPlatformSettings(new MediaPlatformSettings
        {
            ApplicationId = opts.AppId,
            MediaPlatformInstanceSettings = new MediaPlatformInstanceSettings
            {
                CertificateThumbprint = opts.CertificateThumbprint,
                InstanceInternalPort = opts.InstanceInternalPort,
                InstancePublicPort = opts.InstancePublicPort,
                InstancePublicIPAddress = System.Net.IPAddress.Parse(opts.InstancePublicIpAddress),
                ServiceFqdn = opts.ServiceFqdn,
            },
        });

        // Build() initializes the media platform; this is where a bad cert/FQDN/port fails fast.
        _client = builder.Build();
        _client.Calls().OnUpdated += OnCallsUpdated;
    }

    private static void Validate(GraphBotOptions o)
    {
        var missing = new List<string>();
        if (string.IsNullOrWhiteSpace(o.AppId)) missing.Add("GraphBot:AppId");
        if (string.IsNullOrWhiteSpace(o.AppSecret)) missing.Add("GraphBot:AppSecret");
        if (string.IsNullOrWhiteSpace(o.NotificationUrl)) missing.Add("GraphBot:NotificationUrl");
        if (string.IsNullOrWhiteSpace(o.ServiceFqdn)) missing.Add("GraphBot:ServiceFqdn");
        if (string.IsNullOrWhiteSpace(o.CertificateThumbprint)) missing.Add("GraphBot:CertificateThumbprint");
        if (missing.Count > 0) throw new InvalidOperationException("Missing configuration: " + string.Join(", ", missing));
    }

    // ---------------------------------------------------------------- join / leave

    public async Task JoinAsync(JoinArgs args)
    {
        if (_sessions.ContainsKey(args.InterviewId)) throw new InvalidOperationException("already joined");

        var (chatInfo, meetingInfo) = JoinUrlParser.Parse(args.JoinUrl);
        var tenantId = !string.IsNullOrWhiteSpace(args.TenantId) ? args.TenantId : JoinUrlParser.TenantOf(meetingInfo);
        if (string.IsNullOrWhiteSpace(tenantId))
            throw new ArgumentException(
                "tenantId is required for short meeting links (teams.microsoft.com/meet/...): the link does not carry the organizer's tenant.");

        var scenarioId = Guid.NewGuid();
        var session = new CallSession(
            args.InterviewId, _sink, _speech,
            new ParticipantDirectory(args.InterviewerAadId),
            _loggerFactory.CreateLogger($"Call:{args.InterviewId}"));

        // Subscribe to media BEFORE adding the call; audio can start flowing during negotiation.
        var media = _client.CreateMediaSession(
            new AudioSocketSettings
            {
                StreamDirections = StreamDirection.Recvonly,
                SupportedAudioFormat = AudioFormat.Pcm16K,
                ReceiveUnmixedMeetingAudio = true, // per-speaker audio; the whole design depends on this
            });
        session.AttachMedia(media);

        var joinParams = new JoinMeetingParameters(chatInfo, meetingInfo, media) { TenantId = tenantId };
        if (string.Equals(_opts.JoinAs, "guest", StringComparison.OrdinalIgnoreCase))
        {
            joinParams.GuestIdentity = new Identity { Id = Guid.NewGuid().ToString(), DisplayName = _opts.DisplayName };
        }

        if (!_sessions.TryAdd(args.InterviewId, session))
        {
            await session.DisposeAsync();
            throw new InvalidOperationException("already joined");
        }

        try
        {
            var call = await _client.Calls().AddAsync(joinParams, scenarioId).ConfigureAwait(false);
            session.BindCall(call, () => Forget(args.InterviewId));
            _log.LogInformation("join requested: interview {Id}, call {CallId}, tenant {Tenant}", args.InterviewId, call.Id, tenantId);

            // We cannot see the lobby directly; if we are not established yet, tell the interviewer to admit us.
            if (call.Resource.State != CallState.Established)
                await _sink.LobbyWaitingAsync(args.InterviewId).ConfigureAwait(false);
        }
        catch
        {
            await session.DisposeAsync();
            _sessions.TryRemove(args.InterviewId, out _);
            throw;
        }
    }

    public async Task LeaveAsync(string interviewId)
    {
        if (!_sessions.TryGetValue(interviewId, out var session)) return;
        session.LeaveRequested = true;
        try
        {
            if (session.Call is not null) await session.Call.DeleteAsync().ConfigureAwait(false);
        }
        catch (Exception e)
        {
            _log.LogWarning(e, "DeleteAsync failed, forcing local removal");
            if (session.Call is not null) _client.Calls().TryForceRemove(session.Call.Id, out _);
        }
    }

    private void Forget(string interviewId)
    {
        if (_sessions.TryRemove(interviewId, out var s)) _ = s.DisposeAsync();
    }

    private void OnCallsUpdated(ICallCollection sender, CollectionEventArgs<ICall> args)
    {
        // Safety net: if the SDK drops a call without a Terminated update, clean up.
        foreach (var call in args.RemovedResources)
        {
            var s = _sessions.Values.FirstOrDefault(x => x.Call?.Id == call.Id);
            if (s is not null)
            {
                s.OnRemoved();
                Forget(s.InterviewId);
            }
        }
    }

    // ---------------------------------------------------------------- webhook

    public Task<HttpResponseMessage> ProcessNotificationAsync(HttpRequestMessage request) =>
        _client.ProcessNotificationAsync(request);

    public void Dispose()
    {
        foreach (var s in _sessions.Values) _ = s.DisposeAsync();
        _sessions.Clear();
        _client.Dispose();
    }

    // ---------------------------------------------------------------- per-call state

    private sealed class CallSession : IAsyncDisposable
    {
        private readonly IEventSink _sink;
        private readonly SpeechOptions _speech;
        private readonly ILogger _log;
        private readonly Stopwatch _sinceJoin = Stopwatch.StartNew();
        private readonly object _gate = new();

        private ILocalMediaSession? _media;
        private IAudioSocket? _audio;
        private SpeechTranscriber? _transcriber;
        private Action? _onDone;
        private bool _established;
        private bool _ended;
        private int _disposed;

        // Transcription is OFF until Teams confirms updateRecordingStatus(recording). See class remarks.
        private volatile bool _recordingOk;

        public CallSession(string interviewId, IEventSink sink, SpeechOptions speech, ParticipantDirectory directory, ILogger log)
        {
            InterviewId = interviewId;
            _sink = sink;
            _speech = speech;
            Directory = directory;
            _log = log;
        }

        public string InterviewId { get; }
        public ParticipantDirectory Directory { get; }
        public ICall? Call { get; private set; }
        public bool LeaveRequested { get; set; }

        public void AttachMedia(ILocalMediaSession media)
        {
            _media = media;
            _audio = media.AudioSocket ?? throw new InvalidOperationException("media session has no audio socket");
            _audio.AudioMediaReceived += OnAudioMediaReceived;
        }

        public void BindCall(ICall call, Action onDone)
        {
            Call = call;
            _onDone = onDone;
            call.OnUpdated += OnCallUpdated;
            call.Participants.OnUpdated += OnParticipantsUpdated;
            foreach (var p in call.Participants) TrackParticipant(p);
        }

        // ---- call state

        private void OnCallUpdated(ICall sender, ResourceEventArgs<Call> e)
        {
            var oldState = e.OldResource?.State;
            var newState = e.NewResource.State;
            if (oldState == newState) return;
            _log.LogInformation("call state {Old} -> {New}", oldState, newState);

            if (newState == CallState.Established) _ = OnEstablishedAsync();
            else if (newState == CallState.Terminated) OnTerminated(e.NewResource);
        }

        private async Task OnEstablishedAsync()
        {
            lock (_gate)
            {
                if (_established) return;
                _established = true;
            }

            try
            {
                await _sink.AdmittedAsync(InterviewId).ConfigureAwait(false);

                // Microsoft rule: no recording / derived data (transcripts) until this succeeds.
                await Call!.UpdateRecordingStatusAsync(RecordingStatus.Recording).ConfigureAwait(false);
                _transcriber = new SpeechTranscriber(_speech, InterviewId, Directory, _sink, _log);
                _recordingOk = true;
                await _sink.RecordingStatusAsync(InterviewId, true, null).ConfigureAwait(false);
                _log.LogInformation("recording status accepted; transcription enabled");
            }
            catch (Exception ex)
            {
                // Most likely spike finding: Graph refuses this for bots that were not invited via compliance policy.
                _log.LogError(ex, "updateRecordingStatus failed; staying silent (no transcript)");
                await _sink.RecordingStatusAsync(InterviewId, false, ex.Message).ConfigureAwait(false);
            }
        }

        private void OnTerminated(Call resource)
        {
            var result = resource.ResultInfo;
            _log.LogInformation("call terminated: code={Code} subcode={Sub} message={Msg}", result?.Code, result?.Subcode, result?.Message);

            var reason = LeaveRequested ? EndReason.Removed
                : !_established ? EndReason.NotAdmitted
                : EndReason.MeetingEnded;
            Finish(reason);
        }

        public void OnRemoved() => Finish(LeaveRequested ? EndReason.Removed : _established ? EndReason.MeetingEnded : EndReason.Error);

        private void Finish(EndReason reason)
        {
            lock (_gate)
            {
                if (_ended) return;
                _ended = true;
            }

            _ = _sink.EndedAsync(InterviewId, reason);
            _onDone?.Invoke();
        }

        // ---- participants

        private void OnParticipantsUpdated(IParticipantCollection sender, CollectionEventArgs<IParticipant> args)
        {
            foreach (var p in args.AddedResources) TrackParticipant(p);
            foreach (var p in args.RemovedResources)
            {
                p.OnUpdated -= OnParticipantUpdated;
                Directory.Remove(p);
            }
        }

        private void TrackParticipant(IParticipant p)
        {
            Directory.Refresh(p);
            p.OnUpdated += OnParticipantUpdated; // media streams show up after the participant does
        }

        private void OnParticipantUpdated(IParticipant sender, ResourceEventArgs<Participant> e) => Directory.Refresh(sender);

        // ---- audio

        private void OnAudioMediaReceived(object? sender, AudioMediaReceivedEventArgs e)
        {
            // Runs on the media platform thread: copy out, release the buffer, never block.
            try
            {
                var transcriber = _transcriber;
                if (!_recordingOk || transcriber is null) return;

                var unmixed = e.Buffer.UnmixedAudioBuffers;
                if (unmixed is null) return;
                foreach (var u in unmixed)
                {
                    if (u.Length <= 0) continue;
                    var bytes = new byte[u.Length];
                    Marshal.Copy(u.Data, bytes, 0, (int)u.Length);
                    transcriber.Push((uint)u.ActiveSpeakerId, bytes);
                }
            }
            catch (Exception ex)
            {
                _log.LogError(ex, "audio handling failed");
            }
            finally
            {
                e.Buffer.Dispose();
            }
        }

        // ---- teardown

        public ValueTask DisposeAsync()
        {
            if (Interlocked.Exchange(ref _disposed, 1) == 1) return ValueTask.CompletedTask;

            try
            {
                if (_audio is not null) _audio.AudioMediaReceived -= OnAudioMediaReceived;
                if (Call is not null)
                {
                    Call.OnUpdated -= OnCallUpdated;
                    Call.Participants.OnUpdated -= OnParticipantsUpdated;
                    foreach (var p in Call.Participants) p.OnUpdated -= OnParticipantUpdated;
                }

                _recordingOk = false;
                _transcriber?.Dispose();
                _media?.Dispose();
            }
            catch (Exception ex)
            {
                _log.LogWarning(ex, "error during session teardown");
            }

            return ValueTask.CompletedTask;
        }
    }

    /// <summary>Bridges Graph SDK log events into Microsoft.Extensions.Logging.</summary>
    private sealed class GraphLogObserver : IObserver<LogEvent>
    {
        private readonly ILogger _log;
        public GraphLogObserver(ILogger log) => _log = log;
        public void OnCompleted() { }
        public void OnError(Exception error) => _log.LogError(error, "graph logger error");

        public void OnNext(LogEvent value)
        {
            var level = value.Level switch
            {
                TraceLevel.Error => LogLevel.Error,
                TraceLevel.Warning => LogLevel.Warning,
                TraceLevel.Info => LogLevel.Information,
                _ => LogLevel.Debug,
            };
            _log.Log(level, "{Message}", value.Message);
        }
    }
}
