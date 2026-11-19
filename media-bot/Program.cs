using System.Security.Cryptography;
using System.Text;
using MediaBot;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddHttpClient<IEventSink, BackendEventSink>();

var mode = builder.Configuration["Bot:Mode"] ?? "stub";
var graphOpts = builder.Configuration.GetSection("GraphBot").Get<GraphBotOptions>() ?? new GraphBotOptions();
var speechOpts = builder.Configuration.GetSection("Speech").Get<SpeechOptions>() ?? new SpeechOptions();
builder.Services.AddSingleton(graphOpts);
builder.Services.AddSingleton(speechOpts);

if (mode == "graph")
{
    // Our web port is configured HERE, in code, from a private "BotHttp" section, and NOT through the standard
    // "Kestrel:Endpoints" config or ASPNETCORE_URLS. Microsoft's media platform embeds its own ASP.NET Core host
    // (MPAzAppHost uses CreateDefaultBuilder + Kestrel) that reads the same appsettings*.json and environment
    // variables. Putting Kestrel endpoints in shared config made the media platform bind our port first and our own
    // server then failed with "address already in use".
    var port = builder.Configuration.GetValue("BotHttp:Port", 443);
    var thumbprint = graphOpts.CertificateThumbprint;
    builder.WebHost.ConfigureKestrel(kestrel =>
    {
        kestrel.ListenAnyIP(port, listen =>
        {
            using var store = new System.Security.Cryptography.X509Certificates.X509Store(
                System.Security.Cryptography.X509Certificates.StoreName.My,
                System.Security.Cryptography.X509Certificates.StoreLocation.LocalMachine);
            store.Open(System.Security.Cryptography.X509Certificates.OpenFlags.ReadOnly);
            var cert = store.Certificates
                .Find(System.Security.Cryptography.X509Certificates.X509FindType.FindByThumbprint, thumbprint, validOnly: false)
                .OfType<System.Security.Cryptography.X509Certificates.X509Certificate2>()
                .FirstOrDefault()
                ?? throw new InvalidOperationException($"Certificate {thumbprint} not found in LocalMachine\\My");
            listen.UseHttps(cert);
        });
    });

    // Real Teams bot. Windows only: needs the real-time media platform (see doc/spike-runbook.md).
    builder.Services.AddSingleton<GraphAuthProvider>();
    builder.Services.AddSingleton<GraphMeetingBot>();
    builder.Services.AddSingleton<IMeetingBot>(sp => sp.GetRequiredService<GraphMeetingBot>());
    builder.Services.AddSingleton<IGraphCallbackProcessor>(sp => sp.GetRequiredService<GraphMeetingBot>());
}
else
{
    builder.Services.AddSingleton<IMeetingBot, StubMeetingBot>();
}

var app = builder.Build();

var apiKey = app.Configuration["Bot:ApiKey"];
if (string.IsNullOrEmpty(apiKey))
    throw new InvalidOperationException("Bot:ApiKey is required (the backend sends it as a Bearer token)");

bool KeyOk(HttpRequest req)
{
    var header = req.Headers.Authorization.ToString();
    var given = Encoding.UTF8.GetBytes(header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase) ? header[7..] : "");
    var want = Encoding.UTF8.GetBytes(apiKey);
    return given.Length == want.Length && CryptographicOperations.FixedTimeEquals(given, want);
}

// Fail fast in graph mode: construct the bot now so a bad cert/FQDN/port shows up at startup, not at first join.
if (mode == "graph") _ = app.Services.GetRequiredService<GraphMeetingBot>();

app.MapGet("/health", () => Results.Ok(new { ok = true, mode }));

app.MapPost("/api/join", async (HttpRequest req, JoinRequest body, IMeetingBot bot, ILogger<Program> log) =>
{
    if (!KeyOk(req)) return Results.Unauthorized();
    if (string.IsNullOrWhiteSpace(body.InterviewId) || !Uri.TryCreate(body.JoinUrl, UriKind.Absolute, out var u)
        || u.Scheme != Uri.UriSchemeHttps || (u.Host != "teams.microsoft.com" && u.Host != "teams.live.com"))
        return Results.BadRequest(new { error = "interviewId and a Teams https joinUrl are required" });

    try
    {
        await bot.JoinAsync(new JoinArgs(body.InterviewId, body.JoinUrl, body.TenantId, body.InterviewerAadId));
        return Results.Accepted();
    }
    catch (InvalidOperationException e)
    {
        return Results.Conflict(new { error = e.Message });
    }
    catch (ArgumentException e)
    {
        return Results.BadRequest(new { error = e.Message });
    }
    catch (Exception e)
    {
        log.LogError(e, "join failed for {Id}", body.InterviewId);
        return Results.Problem("join failed: " + e.Message, statusCode: 502);
    }
});

app.MapPost("/api/leave", async (HttpRequest req, LeaveRequest body, IMeetingBot bot) =>
{
    if (!KeyOk(req)) return Results.Unauthorized();
    await bot.LeaveAsync(body.InterviewId);
    return Results.Accepted();
});

// Graph call-state notifications. Authenticity is checked by GraphAuthProvider.ValidateInboundRequestAsync
// inside the SDK, not by the API key.
app.MapPost("/callback", async (HttpContext ctx) =>
{
    var processor = ctx.RequestServices.GetService<IGraphCallbackProcessor>();
    if (processor is null) return Results.StatusCode(StatusCodes.Status501NotImplemented);

    var baseUri = new Uri(new Uri(graphOpts.NotificationUrl).GetLeftPart(UriPartial.Authority));
    using var request = await GraphHttp.ToRequestMessageAsync(ctx.Request, baseUri);
    using var response = await processor.ProcessNotificationAsync(request);
    await GraphHttp.CopyToResponseAsync(response, ctx.Response);
    return Results.Empty;
});

app.Run();

record JoinRequest(string InterviewId, string JoinUrl, string? TenantId = null, string? InterviewerAadId = null);
record LeaveRequest(string InterviewId);

/// <summary>ASP.NET Core request/response to HttpRequestMessage bridging (the SDK speaks HttpRequestMessage).</summary>
static class GraphHttp
{
    public static async Task<HttpRequestMessage> ToRequestMessageAsync(HttpRequest req, Uri baseUri)
    {
        var msg = new HttpRequestMessage(new HttpMethod(req.Method), new Uri(baseUri, req.Path + req.QueryString));
        using var ms = new MemoryStream();
        await req.Body.CopyToAsync(ms);
        msg.Content = new ByteArrayContent(ms.ToArray());
        foreach (var h in req.Headers)
        {
            if (!msg.Headers.TryAddWithoutValidation(h.Key, h.Value.ToArray()))
                msg.Content.Headers.TryAddWithoutValidation(h.Key, h.Value.ToArray());
        }
        return msg;
    }

    public static async Task CopyToResponseAsync(HttpResponseMessage src, HttpResponse dst)
    {
        // All headers must be set BEFORE the body is written; afterwards ASP.NET Core throws
        // "Headers are read-only, response has already started" (seen in the first real call).
        dst.StatusCode = (int)src.StatusCode;
        foreach (var h in src.Headers) dst.Headers[h.Key] = h.Value.ToArray();
        if (src.Content is not null)
            foreach (var h in src.Content.Headers) dst.Headers[h.Key] = h.Value.ToArray();
        dst.Headers.Remove("transfer-encoding");
        // Close the connection so Teams does not pin a call to one instance (matches Microsoft's samples).
        dst.Headers.Connection = "close";

        if (src.Content is not null) await src.Content.CopyToAsync(dst.Body);
    }
}
