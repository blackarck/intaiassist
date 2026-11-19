using System.Collections.Concurrent;

namespace MediaBot;

/// <summary>
/// Simulates a bot: lobby -> admitted -> a scripted interviewer/candidate exchange -> ended.
/// Lets us exercise backend dispatch, status updates and the segment pipeline without Teams.
/// </summary>
public sealed class StubMeetingBot : IMeetingBot
{
    private readonly IEventSink _sink;
    private readonly ILogger<StubMeetingBot> _log;
    private readonly ConcurrentDictionary<string, CancellationTokenSource> _runs = new();

    public StubMeetingBot(IEventSink sink, ILogger<StubMeetingBot> log)
    {
        _sink = sink;
        _log = log;
    }

    private static readonly (string Role, string Name, string Text)[] Script =
    {
        ("interviewer", "Interviewer", "Thanks for joining. Can you walk me through a system you designed recently?"),
        ("candidate", "Candidate", "Sure. I built an event-driven order pipeline using Kafka and Postgres that handled about ten thousand orders a minute."),
        ("interviewer", "Interviewer", "How did you handle duplicate events?"),
        ("candidate", "Candidate", "We made consumers idempotent using an order id and a processed-events table."),
    };

    public Task JoinAsync(JoinArgs args)
    {
        var interviewId = args.InterviewId;
        _log.LogInformation("[stub] join {Id} {Url} tenant={Tenant}", interviewId, args.JoinUrl, args.TenantId);
        var cts = new CancellationTokenSource();
        if (!_runs.TryAdd(interviewId, cts)) throw new InvalidOperationException("already joined");
        _ = Task.Run(() => RunAsync(interviewId, cts.Token));
        return Task.CompletedTask;
    }

    public async Task LeaveAsync(string interviewId)
    {
        if (_runs.TryRemove(interviewId, out var cts))
        {
            cts.Cancel();
            await _sink.EndedAsync(interviewId, EndReason.Removed);
        }
    }

    private async Task RunAsync(string id, CancellationToken ct)
    {
        try
        {
            await _sink.LobbyWaitingAsync(id);
            await Task.Delay(2000, ct);
            await _sink.AdmittedAsync(id);
            await _sink.RecordingStatusAsync(id, true, "stub");

            long t = 0;
            foreach (var (role, name, text) in Script)
            {
                await Task.Delay(1500, ct);
                t += 1500;
                await _sink.SegmentAsync(new TranscriptSegment(id, role + "-1", name, role, text, true, t));
            }

            await Task.Delay(1000, ct);
            if (_runs.TryRemove(id, out _)) await _sink.EndedAsync(id, EndReason.MeetingEnded);
        }
        catch (OperationCanceledException) { /* left early */ }
        catch (Exception e)
        {
            _log.LogError(e, "[stub] run failed");
            _runs.TryRemove(id, out _);
            await _sink.EndedAsync(id, EndReason.Error);
        }
    }
}
