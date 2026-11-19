using System.Collections.Concurrent;
using Microsoft.Graph;
using Microsoft.Graph.Models;
using Microsoft.Graph.Communications.Calls;

namespace MediaBot;

public sealed record Person(string? UserId, string? DisplayName, bool InLobby);

/// <summary>
/// Maps a Teams audio source id (MSI, the id on each unmixed audio buffer) to who is speaking.
/// Entries appear/refresh as participants join and their media streams are negotiated.
/// </summary>
public sealed class ParticipantDirectory
{
    private readonly ConcurrentDictionary<uint, Person> _byMsi = new();
    private readonly string? _interviewerAadId;

    public ParticipantDirectory(string? interviewerAadId) => _interviewerAadId = interviewerAadId;

    public void Refresh(IParticipant participant)
    {
        var r = participant.Resource;
        var user = r?.Info?.Identity?.User;
        var person = new Person(user?.Id, user?.DisplayName, r?.IsInLobby == true);
        foreach (var s in r?.MediaStreams ?? Enumerable.Empty<MediaStream>())
        {
            if (s.MediaType == Modality.Audio && uint.TryParse(s.SourceId, out var msi))
                _byMsi[msi] = person;
        }
    }

    public void Remove(IParticipant participant)
    {
        foreach (var s in participant.Resource?.MediaStreams ?? Enumerable.Empty<MediaStream>())
            if (s.MediaType == Modality.Audio && uint.TryParse(s.SourceId, out var msi))
                _byMsi.TryRemove(msi, out _);
    }

    public (string SpeakerId, string? Name, string Role) Resolve(uint msi)
    {
        if (!_byMsi.TryGetValue(msi, out var p)) return (msi.ToString(), null, "unknown");

        string role;
        if (_interviewerAadId is not null && string.Equals(p.UserId, _interviewerAadId, StringComparison.OrdinalIgnoreCase))
            role = "interviewer";
        else if (_interviewerAadId is not null)
            role = "candidate"; // two-person interview assumption; refine for panels
        else
            role = "unknown";

        return (p.UserId ?? msi.ToString(), p.DisplayName, role);
    }
}
